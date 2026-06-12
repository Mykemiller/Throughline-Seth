/**
 * The River-write boundary — REAL (E13-03/04, THOUG-132).
 *
 * Durable rule #3: never write to the River silently. Every function here is
 * called ONLY from the confirmation path in clm.ts / the photo route — never
 * from the spoken/free-text channel. All First Thread writes are Tab B:
 * visibility='private' is set EXPLICITLY (B4 — never rely on the DB default,
 * which is 'public'), companion='seth', source='first_thread_voice'.
 *
 * Idempotency (v0.2 hardening): sync_idempotency_key =
 * sha256(subscriber_id + session_id + chapter + turn). Dropped-packet retries
 * merge rather than duplicate — we look the key up before inserting.
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

/**
 * Commit a CONFIRMED moment_draft to rot_moments. Layer 2 Moment,
 * medium='voice', private, provenance stamped. Returns the moment_id.
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
      visibility: 'private', // B4: explicit, never the DB default
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
 * Commit a CONFIRMED story_draft as a Layer 3 Story (photo commentary or
 * longer narrative), anchored to its parent Moment via cluster_root_id.
 */
export async function commitStoryDraft(args: {
  subscriberId: string;
  sessionId: string;
  draft: StoryDraftPayload;
  turn: number;
  /** The Moment this story belongs to (e.g. the pinned photo's Moment). */
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
      visibility: 'private', // B4: explicit
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

/**
 * Record a Reverence closure durably in subscriber_closed_topics
 * (signal='closed_door', status='closed', tokenized match_tokens — B5).
 * The in-memory block in the snapshot is already active BEFORE this write
 * (defense-in-depth #2 — the next-utterance race is closed without the DB).
 */
export async function recordClosedTopicEvent(args: {
  subscriberId: string;
  sessionId: string;
  payload: ClosedTopicEventPayload;
  /** The raw utterance, so we can extract the named topic's tokens. */
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
