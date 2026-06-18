/**
 * flowEngine.ts — the seven-chapter state machine (THOUG-131 / E13-T3).
 *
 * Pure, deterministic functions over SessionStateSnapshot — no I/O. The voice
 * runtime (THOUG-129) drives it but does not own chapter logic. The runtime
 * persists the returned snapshot to rot_capture_sessions.state_snapshot every
 * turn (E13-08 recovery).
 *
 * Behavior owned here (the scaffold owns the words):
 *  - canonical chapter order + legal advances (never backward, never skipping)
 *  - the one-bounded-follow-up rule per chapter
 *  - transition carries
 *  - closed-topic recording + the pre-prompt gate (token match, never fuzzy)
 *  - chapter completeness (≥1 confirmed Moment; never forced)
 *  - dynamic pacing lookup (silence tolerance scaled by chapter)
 *  - turn counting for the deterministic sync_idempotency_key
 */

import type {
  ChapterCompletePayload,
  ChapterId,
  IntroCompletePayload,
  ClosedScope,
  MomentDraftPayload,
  PendingPhoto,
  SessionStateSnapshot,
  StoryDraftPayload,
} from './types.js';
import { CHAPTER_ORDER, getChapter, initialStateSnapshot } from './sethScaffold.js';
import { tokensForTopic } from './reverenceFilter.js';

/* ── Snapshot hygiene ─────────────────────────────────────────────────────── */

/**
 * Upgrade any persisted snapshot (including legacy pre-v5 shapes) to the
 * current v5 shape without losing closures. Resume must never drop a closed
 * scope. Fields added in v5 (photoQueue, photosSinceRecap, lastActivityAt,
 * namedIdentities) default safely when absent from an older snapshot.
 */
export function reviveSnapshot(raw: unknown): SessionStateSnapshot {
  const fresh = initialStateSnapshot();
  if (!raw || typeof raw !== 'object') return fresh;
  const o = raw as Record<string, unknown>;
  const chapterId = CHAPTER_ORDER.includes(o.chapterId as ChapterId)
    ? (o.chapterId as ChapterId)
    : fresh.chapterId;
  const closedScopes: ClosedScope[] = Array.isArray(o.closedScopes)
    ? (o.closedScopes as Array<Record<string, unknown>>).map((s) => ({
        phrase: String(s.phrase ?? ''),
        matchTokens: Array.isArray(s.matchTokens)
          ? (s.matchTokens as string[])
          : tokensForTopic(String(s.phrase ?? '')),
        closedAt: String(s.closedAt ?? new Date().toISOString()),
        chapterId: CHAPTER_ORDER.includes(s.chapterId as ChapterId)
          ? (s.chapterId as ChapterId)
          : chapterId,
      }))
    : [];
  return {
    ...fresh,
    chapterId,
    followUpSpent: Boolean(o.followUpSpent),
    turn: typeof o.turn === 'number' ? o.turn : 0,
    closedScopes,
    carry: o.carry && typeof o.carry === 'object' ? (o.carry as Record<string, string>) : {},
    pendingDraft: (o.pendingDraft as SessionStateSnapshot['pendingDraft']) ?? null,
    pendingPhoto: (o.pendingPhoto as SessionStateSnapshot['pendingPhoto']) ?? null,
    activeMomentId: typeof o.activeMomentId === 'string' ? o.activeMomentId : null,
    confirmedMoments:
      o.confirmedMoments && typeof o.confirmedMoments === 'object'
        ? (o.confirmedMoments as SessionStateSnapshot['confirmedMoments'])
        : {},
    // Legacy (pre-intro) snapshots revive straight into the walk — never replay
    // the introduction for a session that was already mid-conversation.
    phase: o.phase === 'intro' || o.phase === 'walk' ? o.phase : 'walk',
    subscriberName: typeof o.subscriberName === 'string' ? o.subscriberName : null,
    recapPending: Boolean(o.recapPending),
    nextSessionRecapPending: Boolean(o.nextSessionRecapPending),
    photoQueue: Array.isArray(o.photoQueue)
      ? (o.photoQueue as SessionStateSnapshot['photoQueue'])
      : [],
    photosSinceRecap: typeof o.photosSinceRecap === 'number' ? o.photosSinceRecap : 0,
    lastActivityAt: typeof o.lastActivityAt === 'string' ? o.lastActivityAt : null,
    namedIdentities: Array.isArray(o.namedIdentities)
      ? (o.namedIdentities as SessionStateSnapshot['namedIdentities'])
      : [],
  };
}

/* ── Turns & pacing ───────────────────────────────────────────────────────── */

/** Count a subscriber turn (monotonic; feeds the idempotency key). */
export function nextTurn(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  return { ...snapshot, turn: snapshot.turn + 1 };
}

/** Dynamic pacing: silence tolerance for the current chapter (v0.2 hardening). */
export function silenceToleranceMs(snapshot: SessionStateSnapshot): number {
  return getChapter(snapshot.chapterId).silenceToleranceMs;
}

/* ── Chapter advancement ──────────────────────────────────────────────────── */

/** True if we're already at the final chapter (Last Night). */
export function isFinalChapter(snapshot: SessionStateSnapshot): boolean {
  return snapshot.chapterId === CHAPTER_ORDER[CHAPTER_ORDER.length - 1];
}

/** Confirmed-Moment count for the current chapter. */
export function confirmedInChapter(snapshot: SessionStateSnapshot): number {
  return snapshot.confirmedMoments[snapshot.chapterId] ?? 0;
}

/**
 * The chapter completeness rule: a chapter is complete when the subscriber has
 * given at least one confirmed River Moment. A chapter is never forced to
 * completion — the engine refuses an advance without it.
 */
export function canAdvance(snapshot: SessionStateSnapshot): boolean {
  return !isFinalChapter(snapshot) && confirmedInChapter(snapshot) > 0;
}

/**
 * Advance one chapter forward (never backward, never skipping), resetting the
 * per-chapter follow-up budget. Refuses an illegal advance by returning the
 * snapshot unchanged.
 */
export function advanceChapter(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  if (!canAdvance(snapshot)) return snapshot;
  const idx = CHAPTER_ORDER.indexOf(snapshot.chapterId);
  const next = CHAPTER_ORDER[idx + 1]!;
  return { ...snapshot, chapterId: next, followUpSpent: false };
}

/* ── Intro phase ──────────────────────────────────────────────────────── */

/** True while the session is still in Seth's spoken introduction. */
export function isIntro(snapshot: SessionStateSnapshot): boolean {
  return snapshot.phase === 'intro';
}

/**
 * Apply an intro_complete signal: record the subscriber's name and flip the
 * session from `intro` into the seven-chapter `walk` (always opening at the
 * first chapter). Idempotent once already in the walk.
 */
export function applyIntroComplete(
  snapshot: SessionStateSnapshot,
  payload: IntroCompletePayload,
): SessionStateSnapshot {
  const name = payload.name?.trim();
  return {
    ...snapshot,
    phase: 'walk',
    subscriberName: name ? name : snapshot.subscriberName,
    chapterId: snapshot.phase === 'intro' ? CHAPTER_ORDER[0]! : snapshot.chapterId,
    followUpSpent: false,
  };
}

/* ── Subscriber-initiated chapter navigation (owner override 2026-06-14) ───── */

/**
 * Jump directly to any chapter at the subscriber's request (the visible chapter
 * rail). This deliberately bypasses the forward-only `advanceChapter` rule:
 * navigation is subscriber-initiated, so order and completeness do not gate it.
 *
 * Reverence is preserved absolutely — closedScopes and confirmedMoments are
 * never touched by a jump; a staged-but-unconfirmed draft is dropped (it
 * belonged to the chapter being left), and any intro is concluded.
 */
export function jumpToChapter(
  snapshot: SessionStateSnapshot,
  target: ChapterId,
): SessionStateSnapshot {
  if (!CHAPTER_ORDER.includes(target)) return snapshot;
  if (snapshot.phase === 'walk' && target === snapshot.chapterId) return snapshot;
  return {
    ...snapshot,
    phase: 'walk',
    chapterId: target,
    followUpSpent: false,
    pendingDraft: null,
  };
}

/**
 * Apply a chapter_complete signal from the model. The ENGINE decides legality:
 * the payload must name the current chapter and the chapter must be complete.
 * The carry detail is stashed for the transition.
 */
export function applyChapterComplete(
  snapshot: SessionStateSnapshot,
  payload: ChapterCompletePayload,
): SessionStateSnapshot {
  if (payload.chapterId !== snapshot.chapterId) return snapshot;
  let next = snapshot;
  if (payload.carryDetail) {
    next = carry(next, `from_${snapshot.chapterId}`, payload.carryDetail);
  }
  return advanceChapter(next);
}

/** Mark the current chapter's single bounded follow-up as spent. */
export function spendFollowUp(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  return { ...snapshot, followUpSpent: true };
}

/** Stash a value to carry into later chapters (e.g. a remembered name). */
export function carry(
  snapshot: SessionStateSnapshot,
  key: string,
  value: string,
): SessionStateSnapshot {
  return { ...snapshot, carry: { ...snapshot.carry, [key]: value } };
}

export function currentChapter(snapshot: SessionStateSnapshot): ChapterId {
  return snapshot.chapterId;
}

/* ── Reverence: closures + the pre-prompt gate ────────────────────────────── */

/**
 * Record a closed-door scope (idempotent on phrase). Once closed, always
 * closed — scopes are never removed by the engine; reversal is
 * subscriber-settings-only, outside this runtime.
 */
export function closeScope(
  snapshot: SessionStateSnapshot,
  phrase: string,
  closedAt: string = new Date().toISOString(),
): SessionStateSnapshot {
  const already = snapshot.closedScopes.some((s) => s.phrase === phrase);
  if (already) return snapshot;
  const scope: ClosedScope = {
    phrase,
    matchTokens: tokensForTopic(phrase),
    closedAt,
    chapterId: snapshot.chapterId,
  };
  return { ...snapshot, closedScopes: [...snapshot.closedScopes, scope] };
}

/**
 * The pre-prompt gate (defense-in-depth #3): does this text touch any closed
 * scope? Exact-match against normalized match_tokens — never fuzzy, never a
 * model. Run before any prompt is emitted and before any draft is staged.
 */
export function touchesClosedScope(
  snapshot: SessionStateSnapshot,
  text: string,
): ClosedScope | null {
  if (!text) return null;
  const tokens = new Set(tokensForTopic(text));
  for (const scope of snapshot.closedScopes) {
    for (const t of scope.matchTokens) {
      if (tokens.has(t)) return scope;
    }
  }
  return null;
}

/* ── Drafts, confirmation, photos ─────────────────────────────────────────── */

/** Stage a draft on the structured channel, awaiting spoken confirmation. */
export function stageDraft(
  snapshot: SessionStateSnapshot,
  payload: MomentDraftPayload | StoryDraftPayload,
): SessionStateSnapshot {
  return { ...snapshot, pendingDraft: { payload, stagedAtTurn: snapshot.turn } };
}

/** Clear the pending draft (declined, or committed by the runtime). */
export function clearDraft(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  return { ...snapshot, pendingDraft: null };
}

/**
 * Make `momentId` the Moment in focus — the pin target for a photo and the
 * anchor for a story — WITHOUT counting it toward chapter completeness. Used
 * when an ambient (pending_review) Moment is written: the photo flow needs a
 * live pin target immediately, but completeness still requires the subscriber's
 * recap confirmation (recordConfirmedMoment). Idempotent on the same id.
 */
export function setActiveMoment(
  snapshot: SessionStateSnapshot,
  momentId: string,
): SessionStateSnapshot {
  if (snapshot.activeMomentId === momentId) return snapshot;
  return { ...snapshot, activeMomentId: momentId };
}

/** Record a confirmed Moment write-back (the runtime did the DB write). */
export function recordConfirmedMoment(
  snapshot: SessionStateSnapshot,
  momentId: string,
): SessionStateSnapshot {
  const count = (snapshot.confirmedMoments[snapshot.chapterId] ?? 0) + 1;
  return {
    ...snapshot,
    pendingDraft: null,
    activeMomentId: momentId,
    confirmedMoments: { ...snapshot.confirmedMoments, [snapshot.chapterId]: count },
  };
}

/** Pin a photo to the active Moment; Seth will elicit commentary next turn. */
export function pinPhoto(
  snapshot: SessionStateSnapshot,
  photo: PendingPhoto,
): SessionStateSnapshot {
  return { ...snapshot, pendingPhoto: photo };
}

/** Clear the pending photo (commentary captured, or abandoned). */
export function clearPhoto(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  return { ...snapshot, pendingPhoto: null };
}

/* ── Spoken confirmation detection (E13-04) ───────────────────────────────── */

const AFFIRM = /\b(yes|yeah|yep|yes it does|that's right|thats right|that's it|sounds right|feels right|exactly|correct|perfect|it does|put it on|place it|save it|keep it)\b/i;
const DECLINE = /\b(no|nope|not quite|that's not right|thats not right|don't save|do not save|leave it off|take it off|don't keep|skip it|not that)\b/i;

/**
 * Deterministic read of the subscriber's spoken confirmation of a pending
 * draft. Decline wins on ambiguity — we never commit on a maybe.
 */
export function detectConfirmation(utterance: string): 'confirm' | 'decline' | 'unclear' {
  if (!utterance) return 'unclear';
  const declined = DECLINE.test(utterance);
  const affirmed = AFFIRM.test(utterance);
  if (declined) return 'decline';
  if (affirmed) return 'confirm';
  return 'unclear';
}
