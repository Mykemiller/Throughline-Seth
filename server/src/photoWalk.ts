/**
 * photoWalk.ts — server-side helpers for the Photo Walk (THOUG-132 v0.3).
 *
 * Owns the DB side of AC10/AC11: fetching the family record for name matching,
 * photo_persons rows (denormalized subscriber_id — D1/BLOCKER fix), the
 * unmatched-name promote/discard lifecycle, place_text capture (D2), and the
 * session-close orphan check for photo-anchored Layer-3 stories.
 *
 * IMPORTANT: photo_persons and rot_moments.place_text land in migration 007,
 * which is written to the repo but NOT applied until explicitly authorized.
 * Every caller goes through clm.ts's safe() wrapper, so a missing table/column
 * degrades to a logged non-fatal error — it must never break a voice turn.
 */
import { randomUUID } from 'node:crypto';
import type { PersonMatchConfidence, PersonRecord } from '@throughline/shared';
import { getDb } from './supabase.js';

/** Fetch the family record for in-memory matching (117 rows — trivially small). */
export async function fetchPersonRecords(): Promise<PersonRecord[]> {
  const { data, error } = await getDb()
    .from('persons')
    .select('id, full_name, given_name, surname, birth_year, alt_names');
  if (error) throw new Error(`fetchPersonRecords failed: ${error.message}`);
  return (data ?? []) as PersonRecord[];
}

export interface PhotoPersonRow {
  photoPersonId: string;
  personId: string | null;
  displayName: string;
  matchConfidence: PersonMatchConfidence;
  status: 'pending_review' | 'committed' | 'removed';
}

/**
 * Record a person the subscriber named in a photo. Idempotent per
 * (subscriber, asset, display_name) so a repeated mention doesn't duplicate.
 * status='removed' is the suppression path (Dead-End Trigger): the row exists
 * as a system-reviewed audit mark but never surfaces anywhere.
 */
export async function insertPhotoPerson(args: {
  subscriberId: string;
  assetId: string;
  personId: string | null;
  displayName: string;
  matchConfidence: PersonMatchConfidence;
  status?: 'pending_review' | 'removed';
}): Promise<PhotoPersonRow> {
  const db = getDb();
  const existing = await db
    .from('photo_persons')
    .select('photo_person_id, person_id, display_name, match_confidence, status')
    .eq('subscriber_id', args.subscriberId)
    .eq('asset_id', args.assetId)
    .ilike('display_name', args.displayName)
    .maybeSingle();
  if (existing.data?.photo_person_id) {
    return {
      photoPersonId: existing.data.photo_person_id as string,
      personId: (existing.data.person_id as string | null) ?? null,
      displayName: existing.data.display_name as string,
      matchConfidence: existing.data.match_confidence as PersonMatchConfidence,
      status: existing.data.status as PhotoPersonRow['status'],
    };
  }
  const { data, error } = await db
    .from('photo_persons')
    .insert({
      subscriber_id: args.subscriberId,
      asset_id: args.assetId,
      person_id: args.personId,
      display_name: args.displayName,
      match_confidence: args.matchConfidence,
      status: args.status ?? 'pending_review',
    })
    .select('photo_person_id')
    .single();
  if (error) throw new Error(`insertPhotoPerson failed: ${error.message}`);
  return {
    photoPersonId: data.photo_person_id as string,
    personId: args.personId,
    displayName: args.displayName,
    matchConfidence: args.matchConfidence,
    status: args.status ?? 'pending_review',
  };
}

/** The one clarifying question resolved an ambiguous name (D4). */
export async function resolvePhotoPerson(
  photoPersonId: string,
  personId: string,
): Promise<void> {
  const { error } = await getDb()
    .from('photo_persons')
    .update({ person_id: personId, match_confidence: 'exact' })
    .eq('photo_person_id', photoPersonId);
  if (error) throw new Error(`resolvePhotoPerson failed: ${error.message}`);
}

/**
 * Unmatched names awaiting the recap's explicit resolution (HIGH-finding fix:
 * no silent limbo). Keyed by subscriber, not session — unresolved names roll
 * into the next session's recap, consistent with the ambient write model.
 */
export async function getUnmatchedPhotoPersons(
  subscriberId: string,
): Promise<Array<{ photoPersonId: string; displayName: string }>> {
  const { data, error } = await getDb()
    .from('photo_persons')
    .select('photo_person_id, display_name')
    .eq('subscriber_id', subscriberId)
    .eq('match_confidence', 'unmatched')
    .eq('status', 'pending_review')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getUnmatchedPhotoPersons failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    photoPersonId: r.photo_person_id as string,
    displayName: r.display_name as string,
  }));
}

/**
 * Promote an unmatched name into the family record: a stub persons row
 * (id 'stub_<uuid>' — persons.id is GEDCOM text, so stubs are namespaced),
 * then link + commit the photo_persons row.
 */
export async function promoteUnmatchedPhotoPerson(args: {
  photoPersonId: string;
  displayName: string;
}): Promise<{ stubPersonId: string }> {
  const db = getDb();
  const stubPersonId = `stub_${randomUUID()}`;
  const { error: personErr } = await db.from('persons').insert({
    id: stubPersonId,
    full_name: args.displayName,
    given_name: args.displayName,
    alt_names: [],
  });
  if (personErr) throw new Error(`stub persons insert failed: ${personErr.message}`);
  const { error } = await db
    .from('photo_persons')
    .update({ person_id: stubPersonId, status: 'committed' })
    .eq('photo_person_id', args.photoPersonId);
  if (error) throw new Error(`promoteUnmatchedPhotoPerson failed: ${error.message}`);
  return { stubPersonId };
}

/** Discard an unmatched name at recap — status='removed', never deleted. */
export async function discardUnmatchedPhotoPerson(photoPersonId: string): Promise<void> {
  const { error } = await getDb()
    .from('photo_persons')
    .update({ status: 'removed' })
    .eq('photo_person_id', photoPersonId)
    .eq('status', 'pending_review');
  if (error) throw new Error(`discardUnmatchedPhotoPerson failed: ${error.message}`);
}

/** Commit the still-pending matched rows when the recap batch is confirmed. */
export async function commitPendingPhotoPersons(subscriberId: string): Promise<void> {
  const { error } = await getDb()
    .from('photo_persons')
    .update({ status: 'committed' })
    .eq('subscriber_id', subscriberId)
    .eq('status', 'pending_review')
    .neq('match_confidence', 'unmatched'); // unmatched resolves via promote/discard only
  if (error) throw new Error(`commitPendingPhotoPersons failed: ${error.message}`);
}

/** D2 — free-text place capture onto the anchor Moment (rot_moments.place_text, 007). */
export async function updateMomentPlace(momentId: string, placeText: string): Promise<void> {
  const { error } = await getDb()
    .from('rot_moments')
    .update({ place_text: placeText })
    .eq('moment_id', momentId);
  if (error) throw new Error(`updateMomentPlace failed: ${error.message}`);
}

/**
 * Session-close orphan check (MEDIUM-finding fix): any pending_review
 * photo-anchored Layer-3 story (cluster_tags ⊃ ['photo_walk']) whose anchor
 * Moment no longer has a media asset is flagged for review — surfaced via a
 * system exchange so the next recap picks it up. Never hard-deleted, no cron.
 */
export async function findOrphanedPhotoStories(
  subscriberId: string,
): Promise<Array<{ momentId: string; title: string; anchorId: string }>> {
  const db = getDb();
  const { data, error } = await db
    .from('rot_moments')
    .select('moment_id, title, cluster_root_id')
    .eq('subscriber_id', subscriberId)
    .eq('source', 'first_thread_voice')
    .eq('status', 'pending_review')
    .eq('layer', 3)
    .contains('cluster_tags', ['photo_walk'])
    .not('cluster_root_id', 'is', null);
  if (error) throw new Error(`findOrphanedPhotoStories failed: ${error.message}`);
  const stories = (data ?? []).map((r) => ({
    momentId: r.moment_id as string,
    title: r.title as string,
    anchorId: r.cluster_root_id as string,
  }));
  if (stories.length === 0) return [];
  const anchorIds = [...new Set(stories.map((s) => s.anchorId))];
  const { data: assets, error: assetErr } = await db
    .from('media_assets')
    .select('moment_id')
    .in('moment_id', anchorIds);
  if (assetErr) throw new Error(`findOrphanedPhotoStories assets failed: ${assetErr.message}`);
  const withAssets = new Set((assets ?? []).map((a) => a.moment_id as string));
  return stories.filter((s) => !withAssets.has(s.anchorId));
}
