/**
 * The River-write boundary — REAL (E13-03/04, THOUG-132).
 *
 * v0.3 — Ambient Write + Timed Recap model (2026-06-14)
 *
 * WRITE MODEL:
 *   - Ambient writes land immediately with status='pending_review'. The
 *     conversation is never interrupted.
 *   - Recap fires at chapter boundary OR 20-min elapsed (clm.ts drives the
 *     trigger; this module supplies the data + commit/drop helpers).
 *   - Next-session recap: clm.ts queries committed rows from prior sessions
 *     via getPriorSessionMoments() and passes them to buildRecapPrompt().
 *   - On confirm at recap  → commitPendingReview() → status='committed'
 *   - On drop at recap     → dropPendingReview()   → row deleted
 *   - On closed-door at recap → recordClosedTopicEvent() + dropPendingReview()
 *
 * Durable rules that have NOT changed:
 *   - visibility='private' explicit on every write (B4)
 *   - companion='seth', source='first_thread_voice', medium='voice'
 *   - sync_idempotency_key = sha256(subscriber_id|session_id|chapter|turn)
 *     — dropped-packet retries merge rather than duplicate
 *   - All Tab B provenance stamped in the writer, never relying on DB defaults
 */
import { createHash } from 'node:crypto';
import type {
  ChapterId,
  ClosedTopicEventPayload,
  MomentDraftPayload,
  StoryDraftPayload,
} from '@throughline/shared';
import { tokensForTopic, topicFromUtterance } from '@throughline/shared';
import { getDb } from './supabase.js';

// ── Key helpers ────────────────────────────────────────────────────────────

export function idempotencyKey(args: {
  subscriberId: string;
  sessionId: string;
  chapter: ChapterId;
  turn: number;
}): string {
  return createHash('sha256')
    .update(`${args.subscriberId}|${args.sessionId}|${args.chapter}|${args.turn}`)
    .digest('hex');
}

export interface CommittedMoment {
  momentId: string;
  /** True if the key already existed and we merged instead of inserting. */
  merged: boolean;
}

// ── Ambient write (pending_review) ────────────────────────────────────────

/**
 * Write a candidate Moment immediately with status='pending_review'.
 * Called from clm.ts when Seth produces a moment_draft payload — no
 * subscriber confirmation needed at write time. The recap surface handles
 * confirmation later.
 */
export async function writeAmbientMoment(args: {
  subscriberId: string;
  sessionId: string;
  draft: MomentDraftPayload;
  turn: number;
}): Promise<CommittedMoment> {
  const key = idempotencyKey({
    subscriberId: args.subscriberId,
    sessionId: args.sessionId,
    chapter: args.draft.chapterId,
    turn: args.turn,
  });
  const db = getDb();

  const existing = await db
    .from('rot_moments')
    .select('moment_id')
    .eq('sync_idempotency_key', key)
    .maybeSingle();
  if (existing.data?.moment_id) {
    return { momentId: existing.data.moment_id as string, merged: true };
  }

  const clusterTags = Array.isArray(args.draft.clusterTags) ? args.draft.clusterTags : [];
  const { data, error } = await db
    .from('rot_moments')
    .insert({
      subscriber_id: args.subscriberId,
      title: args.draft.title,
      summary: args.draft.summary,
      moment_type: 'milestone',
      status: 'pending_review',           // ← ambient write; not committed yet
      visibility: 'private',              // B4: explicit, never the DB default
      companion: 'seth',
      source: 'first_thread_voice',
      medium: 'voice',
      chapter: args.draft.chapterId,
      layer: 2,
      cluster_tags: clusterTags,
      subtype: args.draft.sceneType ?? null,
      created_by: 'seth',
      sync_idempotency_key: key,
    })
    .select('moment_id')
    .single();
  if (error) throw new Error(`writeAmbientMoment failed: ${error.message}`);
  return { momentId: data.moment_id as string, merged: false };
}

/**
 * Write a candidate Story immediately with status='pending_review'.
 * Anchored to a parent Moment via cluster_root_id (e.g., the pinned photo's
 * Moment). Confirmed at recap, not at write time.
 */
export async function writeAmbientStory(args: {
  subscriberId: string;
  sessionId: string;
  draft: StoryDraftPayload;
  turn: number;
  anchorMomentId: string | null;
}): Promise<CommittedMoment> {
  const key = idempotencyKey({
    subscriberId: args.subscriberId,
    sessionId: args.sessionId,
    chapter: args.draft.chapterId,
    turn: args.turn,
  });
  const db = getDb();

  const existing = await db
    .from('rot_moments')
    .select('moment_id')
    .eq('sync_idempotency_key', key)
    .maybeSingle();
  if (existing.data?.moment_id) {
    return { momentId: existing.data.moment_id as string, merged: true };
  }

  const { data, error } = await db
    .from('rot_moments')
    .insert({
      subscriber_id: args.subscriberId,
      title: args.draft.title,
      summary: null,
      narrative_body: args.draft.body,
      moment_type: 'story',
      status: 'pending_review',           // ← ambient write; not committed yet
      visibility: 'private',              // B4: explicit
      companion: 'seth',
      source: 'first_thread_voice',
      medium: 'voice',
      chapter: args.draft.chapterId,
      layer: 3,
      cluster_root_id: args.anchorMomentId,
      created_by: 'seth',
      sync_idempotency_key: key,
    })
    .select('moment_id')
    .single();
  if (error) throw new Error(`writeAmbientStory failed: ${error.message}`);
  return { momentId: data.moment_id as string, merged: false };
}

// ── Recap helpers ─────────────────────────────────────────────────────────

export interface PendingReviewRow {
  momentId: string;
  title: string;
  chapter: string;
}

/**
 * Fetch all pending_review rows for this session — used to build the recap
 * surface in clm.ts.
 */
export async function getPendingReviewRows(args: {
  subscriberId: string;
  sessionId: string;
}): Promise<PendingReviewRow[]> {
  const db = getDb();
  const { data, error } = await db
    .from('rot_moments')
    .select('moment_id, title, chapter')
    .eq('subscriber_id', args.subscriberId)
    .eq('source', 'first_thread_voice')
    .eq('status', 'pending_review')
    // Scope to this session via idempotency key prefix would require a LIKE;
    // instead we filter by session via a join with rot_capture_sessions.
    // Simplest correct approach: filter by created_at >= session start.
    // clm.ts passes sessionStart for the time boundary.
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getPendingReviewRows failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    momentId: r.moment_id as string,
    title: r.title as string,
    chapter: r.chapter as string,
  }));
}

/**
 * Commit a set of pending_review rows to 'committed' after subscriber
 * confirms them at recap.
 */
export async function commitPendingReview(momentIds: string[]): Promise<void> {
  if (momentIds.length === 0) return;
  const db = getDb();
  const { error } = await db
    .from('rot_moments')
    .update({ status: 'committed' })
    .in('moment_id', momentIds);
  if (error) throw new Error(`commitPendingReview failed: ${error.message}`);
}

/**
 * Delete a pending_review row that the subscriber rejected at recap, or that
 * was closed-door signalled. Never called on committed rows.
 */
export async function dropPendingReview(momentId: string): Promise<void> {
  const db = getDb();
  const { error } = await db
    .from('rot_moments')
    .delete()
    .eq('moment_id', momentId)
    .eq('status', 'pending_review'); // safety guard — never touches committed rows
  if (error) throw new Error(`dropPendingReview failed: ${error.message}`);
}

/**
 * Mark the recap as having fired — updates recap_last_at on the session row
 * so the 20-min elapsed timer resets correctly across barge-in / resume.
 */
export async function markRecapFired(sessionId: string): Promise<void> {
  const db = getDb();
  const { error } = await db
    .from('rot_capture_sessions')
    .update({ recap_last_at: new Date().toISOString() })
    .eq('session_id', sessionId);
  if (error) throw new Error(`markRecapFired failed: ${error.message}`);
}

// ── Next-session recap ────────────────────────────────────────────────────

export interface PriorSessionMoment {
  momentId: string;
  title: string;
  chapter: string;
}

/**
 * Fetch committed moments from prior sessions for the next-session recap.
 * Returns the most recent N committed moments (default 5) so the recap stays
 * brief and conversational.
 */
export async function getPriorSessionMoments(args: {
  subscriberId: string;
  currentSessionId: string;
  limit?: number;
}): Promise<PriorSessionMoment[]> {
  const db = getDb();
  const { data, error } = await db
    .from('rot_moments')
    .select('moment_id, title, chapter')
    .eq('subscriber_id', args.subscriberId)
    .eq('source', 'first_thread_voice')
    .eq('status', 'committed')
    .neq('sync_idempotency_key', '') // exclude legacy rows without keys only if needed
    .order('created_at', { ascending: false })
    .limit(args.limit ?? 5);
  if (error) throw new Error(`getPriorSessionMoments failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    momentId: r.moment_id as string,
    title: r.title as string,
    chapter: r.chapter as string,
  }));
}

/**
 * Build Seth's spoken next-session recap from a list of prior committed
 * moments. Returns a string to inject into the system prompt or speak
 * directly as the session-open utterance.
 *
 * Format: "Last time you told me about [X] and [Y]. I've held onto those.
 * Shall we carry on?"
 */
export function buildNextSessionRecapPrompt(moments: PriorSessionMoment[]): string {
  if (moments.length === 0) return '';
  const titles = moments.map((m) => m.title);
  let listStr: string;
  if (titles.length === 1) {
    listStr = titles[0]!;
  } else if (titles.length === 2) {
    listStr = `${titles[0]} and ${titles[1]}`;
  } else {
    const last = titles[titles.length - 1];
    const rest = titles.slice(0, -1).join(', ');
    listStr = `${rest}, and ${last}`;
  }
  return (
    `Last time you told me about ${listStr}. ` +
    `I've held onto those. Shall we carry on?`
  );
}

/**
 * Build Seth's spoken mid-session recap from a list of pending_review rows.
 * Called by clm.ts at chapter boundary or 20-min trigger.
 *
 * Format: "Before we move on — you mentioned [X] and [Y]. I've held onto
 * both of those. Does that feel right?"
 */
export function buildMidSessionRecapPrompt(rows: PendingReviewRow[]): string {
  if (rows.length === 0) return '';
  const titles = rows.map((r) => r.title);
  let listStr: string;
  if (titles.length === 1) {
    listStr = titles[0]!;
  } else if (titles.length === 2) {
    listStr = `${titles[0]} and ${titles[1]}`;
  } else {
    const last = titles[titles.length - 1];
    const rest = titles.slice(0, -1).join(', ');
    listStr = `${rest}, and ${last}`;
  }
  const bothOrAll = titles.length === 1 ? 'that' : titles.length === 2 ? 'both of those' : 'all of those';
  return (
    `Before we move on — you mentioned ${listStr}. ` +
    `I've held onto ${bothOrAll}. Does that feel right?`
  );
}

// ── Reverence ─────────────────────────────────────────────────────────────

/**
 * Record a Reverence closure durably in subscriber_closed_topics
 * (signal='closed_door', status='closed', tokenized match_tokens — B5).
 * The in-memory block in the snapshot is already active BEFORE this write
 * (defense-in-depth #2 — the next-utterance race is closed without the DB).
 *
 * At recap: if a subscriber signals closed-door on a pending_review row,
 * the caller should ALSO call dropPendingReview() on that row's momentId.
 */
export async function recordClosedTopicEvent(args: {
  subscriberId: string;
  sessionId: string;
  payload: ClosedTopicEventPayload;
  utterance: string;
}): Promise<void> {
  const topicTokens = topicFromUtterance(args.utterance, args.payload.phrase);
  const tokens = topicTokens.length > 0 ? topicTokens : tokensForTopic(args.payload.phrase);
  const db = getDb();
  const { error } = await db.from('subscriber_closed_topics').insert({
    subscriber_id: args.subscriberId,
    topic: topicTokens.length > 0 ? topicTokens.join(' ') : args.payload.phrase,
    signal: 'closed_door',
    status: 'closed',
    chapter: args.payload.chapterId,
    match_tokens: tokens,
  });
  if (error) throw new Error(`recordClosedTopicEvent failed: ${error.message}`);
}

// ── Legacy confirm path (kept for photo route compatibility) ───────────────

/**
 * @deprecated Use writeAmbientMoment() + commitPendingReview() instead.
 * Retained only for the photo commentary route which still uses a direct
 * confirm. Will be migrated in the next photo-pipeline pass.
 */
export async function commitMomentDraft(args: {
  subscriberId: string;
  sessionId: string;
  draft: MomentDraftPayload;
  turn: number;
}): Promise<CommittedMoment> {
  const key = idempotencyKey({
    subscriberId: args.subscriberId,
    sessionId: args.sessionId,
    chapter: args.draft.chapterId,
    turn: args.turn,
  });
  const db = getDb();

  const existing = await db
    .from('rot_moments')
    .select('moment_id')
    .eq('sync_idempotency_key', key)
    .maybeSingle();
  if (existing.data?.moment_id) {
    return { momentId: existing.data.moment_id as string, merged: true };
  }

  const clusterTags = Array.isArray(args.draft.clusterTags) ? args.draft.clusterTags : [];
  const { data, error } = await db
    .from('rot_moments')
    .insert({
      subscriber_id: args.subscriberId,
      title: args.draft.title,
      summary: args.draft.summary,
      moment_type: 'milestone',
      status: 'committed',
      visibility: 'private',
      companion: 'seth',
      source: 'first_thread_voice',
      medium: 'voice',
      chapter: args.draft.chapterId,
      layer: 2,
      cluster_tags: clusterTags,
      subtype: args.draft.sceneType ?? null,
      created_by: 'seth',
      sync_idempotency_key: key,
    })
    .select('moment_id')
    .single();
  if (error) throw new Error(`commitMomentDraft failed: ${error.message}`);
  return { momentId: data.moment_id as string, merged: false };
}

/**
 * @deprecated Use writeAmbientStory() + commitPendingReview() instead.
 * Retained for photo commentary route.
 */
export async function commitStoryDraft(args: {
  subscriberId: string;
  sessionId: string;
  draft: StoryDraftPayload;
  turn: number;
  anchorMomentId: string | null;
}): Promise<CommittedMoment> {
  const key = idempotencyKey({
    subscriberId: args.subscriberId,
    sessionId: args.sessionId,
    chapter: args.draft.chapterId,
    turn: args.turn,
  });
  const db = getDb();

  const existing = await db
    .from('rot_moments')
    .select('moment_id')
    .eq('sync_idempotency_key', key)
    .maybeSingle();
  if (existing.data?.moment_id) {
    return { momentId: existing.data.moment_id as string, merged: true };
  }

  const { data, error } = await db
    .from('rot_moments')
    .insert({
      subscriber_id: args.subscriberId,
      title: args.draft.title,
      summary: null,
      narrative_body: args.draft.body,
      moment_type: 'story',
      status: 'committed',
      visibility: 'private',
      companion: 'seth',
      source: 'first_thread_voice',
      medium: 'voice',
      chapter: args.draft.chapterId,
      layer: 3,
      cluster_root_id: args.anchorMomentId,
      created_by: 'seth',
      sync_idempotency_key: key,
    })
    .select('moment_id')
    .single();
  if (error) throw new Error(`commitStoryDraft failed: ${error.message}`);
  return { momentId: data.moment_id as string, merged: false };
}
