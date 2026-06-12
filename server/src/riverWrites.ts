/**
 * The River-write boundary — STUBBED for THOUG-129.
 *
 * Durable rule #3: never write to the River silently; writes happen ONLY from a
 * confirmed structured payload, never from the spoken/free-text channel.
 *
 * THOUG-129's job is to establish the two-channel boundary and the payload
 * types. The confirmation step and the actual Moment/Story writes (Tab B,
 * private-by-default, visibility='private') land in LATER tasks. Everything here
 * is a clearly-marked stub that captures the payload and does NOT touch the
 * database. Do not wire these to real inserts without the confirmation path.
 */
import type { ClosedTopicEventPayload, FirstThreadPayload } from '@throughline/shared';

/**
 * Receive an optional typed payload that Claude emitted on the structured
 * channel (NOT the spoken channel). For now we only record intent — no write.
 *
 * Returns a stub "draft id" so callers can correlate, making the future
 * confirm→commit path easy to slot in.
 */
export function stageDraftPayload(sessionId: string, payload: FirstThreadPayload): { draftId: string; staged: true } {
  const draftId = `draft_stub_${Date.now()}`;
  // STUB: in a later task this becomes a pending-draft row awaiting explicit
  // confirmation, then a Moment/Story write with visibility='private' on commit.
  console.info(
    `[riverWrites STUB] staged ${payload.kind} for session ${sessionId} as ${draftId} — NOT written to the River.`,
    payload,
  );
  return { draftId, staged: true };
}

/**
 * Record a Reverence closure as a closed_topic_event. STUB — no write yet.
 * The authoritative closure already lives in the session state_snapshot
 * (closedScopes); this is the future durable event record.
 */
export function recordClosedTopicEvent(sessionId: string, payload: ClosedTopicEventPayload): void {
  console.info(`[riverWrites STUB] closed_topic_event for session ${sessionId} — NOT written to the River.`, payload);
}
