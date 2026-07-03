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
  HeldPhoto,
  IntroCompletePayload,
  ClosedScope,
  MomentDraftPayload,
  PendingNameClarification,
  PendingPhoto,
  PhotoBeats,
  SessionStateSnapshot,
  StoryDraftPayload,
} from './types.js';
import { CHAPTER_ORDER, getChapter, initialStateSnapshot } from './sethScaffold.js';
import { tokensForTopic } from './reverenceFilter.js';

/* ── Snapshot hygiene ─────────────────────────────────────────────────────── */

/**
 * Upgrade any persisted snapshot (including legacy pre-v5 shapes) to the
 * current v6 shape without losing closures. Resume must never drop a closed
 * scope.
 *
 * This is the READ-TIME SHIM (THOUG-129 closing item): live
 * rot_capture_sessions.state_snapshot rows still include legacy v2 rows
 * (keys: v, turn, carry, chapterId, closedScopes, followUpSpent, pendingDraft,
 * pendingPhoto, activeMomentId, confirmedMoments — no phase, no
 * subscriberName, no recap flags). Detection is field-presence, not version
 * arithmetic: every missing field takes its safe default from
 * initialStateSnapshot(), phase revives as 'walk' (never replay the intro for
 * a mid-conversation session), and v6 Photo Walk fields (photoDeclinedChapters
 * et al.) default empty/false/null.
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
    heldPhotos: Array.isArray(o.heldPhotos)
      ? (o.heldPhotos as SessionStateSnapshot['heldPhotos'])
      : [],
    photoDeclinedChapters: Array.isArray(o.photoDeclinedChapters)
      ? (o.photoDeclinedChapters as ChapterId[]).filter((c) => CHAPTER_ORDER.includes(c))
      : [],
    photoAskedChapters: Array.isArray(o.photoAskedChapters)
      ? (o.photoAskedChapters as ChapterId[]).filter((c) => CHAPTER_ORDER.includes(c))
      : [],
    photoAskPending: Boolean(o.photoAskPending),
    photoAskAwaitingReply: Boolean(o.photoAskAwaitingReply),
    pendingNameClarification:
      (o.pendingNameClarification as SessionStateSnapshot['pendingNameClarification']) ?? null,
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
  return armPhotoAsk({ ...snapshot, chapterId: next, followUpSpent: false });
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
  return armPhotoAsk({
    ...snapshot,
    phase: 'walk',
    subscriberName: name ? name : snapshot.subscriberName,
    chapterId: snapshot.phase === 'intro' ? CHAPTER_ORDER[0]! : snapshot.chapterId,
    followUpSpent: false,
  });
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
  return armPhotoAsk({
    ...snapshot,
    phase: 'walk',
    chapterId: target,
    followUpSpent: false,
    pendingDraft: null,
  });
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

/**
 * Intake a photo for the batch flow (item A). If no photo is in focus it
 * becomes the pinned one; otherwise it queues behind the current photo so a
 * burst of uploads in one turn is handled one at a time, not all at once.
 */
export function enqueuePhoto(
  snapshot: SessionStateSnapshot,
  photo: PendingPhoto,
): SessionStateSnapshot {
  const prepared: PendingPhoto = {
    beats: { memories: false, timePlace: false, people: false },
    ...photo,
    focusedAtTurn: photo.focusedAtTurn ?? snapshot.turn,
  };
  if (!snapshot.pendingPhoto) return { ...snapshot, pendingPhoto: prepared };
  return { ...snapshot, photoQueue: [...snapshot.photoQueue, prepared] };
}

/**
 * The current photo is done — bring the next queued photo into focus, or clear
 * if the queue is empty. Replaces clearPhoto when draining a batch so the
 * series advances one picture at a time.
 */
export function dequeuePhoto(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  const [next, ...rest] = snapshot.photoQueue;
  const focused = next ? { ...next, focusedAtTurn: snapshot.turn } : null;
  return { ...snapshot, pendingPhoto: focused, photoQueue: rest };
}

/** Clear the pending photo (commentary captured, or abandoned). */
export function clearPhoto(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  return { ...snapshot, pendingPhoto: null };
}

/**
 * Hold a photo that arrived before any Moment exists (e.g. during the
 * Introduction). It is already uploaded + vision-analyzed; we keep it until the
 * first Moment so a media_assets row can be written and it can pin.
 */
export function holdPhoto(
  snapshot: SessionStateSnapshot,
  held: HeldPhoto,
): SessionStateSnapshot {
  return { ...snapshot, heldPhotos: [...snapshot.heldPhotos, held] };
}

/** Clear all held photos (materialized onto Moments, or session ended). */
export function clearHeldPhotos(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  if (snapshot.heldPhotos.length === 0) return snapshot;
  return { ...snapshot, heldPhotos: [] };
}

/* ── Photo Walk (THOUG-132 v0.3): chapter ask + three beats + dead end ─────── */

/**
 * Arm the once-per-chapter photo ask on chapter entry (AC8). Eligible unless
 * the chapter was already asked, was declined (D5 chapter-scoped suppression —
 * decline persists across sessions), or photos are already in flight.
 */
export function armPhotoAsk(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  const eligible =
    !snapshot.photoAskedChapters.includes(snapshot.chapterId) &&
    !snapshot.photoDeclinedChapters.includes(snapshot.chapterId);
  if (snapshot.photoAskPending === eligible) return snapshot;
  return { ...snapshot, photoAskPending: eligible };
}

/** The ask went into this turn's prompt — never re-ask this chapter (AC8). */
export function markPhotoAsked(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  const asked = snapshot.photoAskedChapters.includes(snapshot.chapterId)
    ? snapshot.photoAskedChapters
    : [...snapshot.photoAskedChapters, snapshot.chapterId];
  return {
    ...snapshot,
    photoAskPending: false,
    photoAskAwaitingReply: true,
    photoAskedChapters: asked,
  };
}

/** The reply to the ask has been heard (or a photo arrived) — one-shot done. */
export function clearPhotoAskAwaiting(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  if (!snapshot.photoAskAwaitingReply) return snapshot;
  return { ...snapshot, photoAskAwaitingReply: false };
}

/**
 * The subscriber declined this chapter's photo ask (AC8/D5): chapter-scoped,
 * persists across sessions, and is NOT a Reverence closure — it never touches
 * closedScopes or subscriber_closed_topics.
 */
export function declinePhotoAsk(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  const declined = snapshot.photoDeclinedChapters.includes(snapshot.chapterId)
    ? snapshot.photoDeclinedChapters
    : [...snapshot.photoDeclinedChapters, snapshot.chapterId];
  return {
    ...snapshot,
    photoAskPending: false,
    photoAskAwaitingReply: false,
    photoDeclinedChapters: declined,
  };
}

const NO_BEATS: PhotoBeats = { memories: false, timePlace: false, people: false };

/** Beats covered so far for the photo in focus (absent = none, pre-v6 pins). */
export function photoBeats(snapshot: SessionStateSnapshot): PhotoBeats {
  return snapshot.pendingPhoto?.beats ?? NO_BEATS;
}

/** Mark a beat covered on the photo in focus (AC10). No-op without a photo. */
export function markPhotoBeat(
  snapshot: SessionStateSnapshot,
  beat: keyof PhotoBeats,
): SessionStateSnapshot {
  if (!snapshot.pendingPhoto) return snapshot;
  const beats = { ...photoBeats(snapshot), [beat]: true };
  return { ...snapshot, pendingPhoto: { ...snapshot.pendingPhoto, beats } };
}

/**
 * Reverence Dead-End Trigger (P0): permanently bypass the who's-in-it beat for
 * the photo in focus. The beat is recorded as covered so the thread can still
 * close; Seth is never told why (no acknowledgment, no near-miss phrasing).
 */
export function suppressPeopleBeat(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  if (!snapshot.pendingPhoto) return snapshot;
  const beats = { ...photoBeats(snapshot), people: true };
  return {
    ...snapshot,
    pendingPhoto: { ...snapshot.pendingPhoto, beats, peopleSuppressed: true },
  };
}

/** All three beats touched (a suppressed people beat counts as covered). */
export function photoBeatsComplete(snapshot: SessionStateSnapshot): boolean {
  if (!snapshot.pendingPhoto) return true;
  const b = photoBeats(snapshot);
  return b.memories && b.timePlace && b.people;
}

/** Turns the current photo has been in focus (safety valve for a stuck thread). */
export function photoFocusTurns(snapshot: SessionStateSnapshot): number {
  if (!snapshot.pendingPhoto) return 0;
  return snapshot.turn - (snapshot.pendingPhoto.focusedAtTurn ?? snapshot.turn);
}

/** Arm the one-and-done disambiguation question (D4). */
export function setNameClarification(
  snapshot: SessionStateSnapshot,
  clarification: PendingNameClarification,
): SessionStateSnapshot {
  return { ...snapshot, pendingNameClarification: clarification };
}

/** The one clarifying question has had its answer (resolved or not) — done. */
export function clearNameClarification(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  if (!snapshot.pendingNameClarification) return snapshot;
  return { ...snapshot, pendingNameClarification: null };
}

/* ── Recap triggers: soft photo cap + idle/operational return (item B) ─────── */

/** Soft cap on photos gathered before Seth suggests a recap pause (skill §5.1). */
export const PHOTO_SOFT_CAP = 5;

/** Idle gap that marks an operational return (app backgrounded / stepped away). */
export const IDLE_RETURN_MS = 4 * 60 * 60 * 1000; // ~4 hours

/** Count a freshly pinned photo toward the soft-cap recap trigger. */
export function countPhotoForRecap(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  return { ...snapshot, photosSinceRecap: snapshot.photosSinceRecap + 1 };
}

/** Reset the photo counter — called when a recap fires. */
export function resetPhotosSinceRecap(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  if (snapshot.photosSinceRecap === 0) return snapshot;
  return { ...snapshot, photosSinceRecap: 0 };
}

/** True once enough photos have gathered to suggest a natural recap pause. */
export function hitPhotoSoftCap(snapshot: SessionStateSnapshot): boolean {
  return snapshot.photosSinceRecap >= PHOTO_SOFT_CAP;
}

/** Stamp the last-activity time (caller passes the ISO string; keeps this pure). */
export function markActivity(
  snapshot: SessionStateSnapshot,
  atIso: string,
): SessionStateSnapshot {
  return { ...snapshot, lastActivityAt: atIso };
}

/**
 * Operational return: the session resumed after a long inactivity gap (app
 * backgrounded, dropped, stepped away). This is NOT a closed door — Seth offers
 * a gentle re-entry nudge. `nowMs` is passed in so the function stays pure.
 */
export function isOperationalReturn(
  snapshot: SessionStateSnapshot,
  nowMs: number,
  thresholdMs: number = IDLE_RETURN_MS,
): boolean {
  if (!snapshot.lastActivityAt) return false;
  const last = new Date(snapshot.lastActivityAt).getTime();
  if (Number.isNaN(last)) return false;
  return nowMs - last > thresholdMs;
}

/* ── Intra-session identity capture (item D, deterministic parser) ─────────── */

/** Relationship cues that strongly imply the following word is a person's name. */
const RELATIONSHIP =
  '(?:dad|daddy|father|mom|mum|mommy|mother|brother|sister|son|daughter|husband|' +
  'wife|aunt|auntie|uncle|grandfather|grandmother|grandpa|grandma|granddad|granny|' +
  'cousin|friend|neighbour|neighbor|partner|fiance|fiancee|boyfriend|girlfriend)';

/** A name: one or two Capitalized tokens (e.g. "Arthur", "Mary Beth"). */
const NAME = "[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?";

/**
 * Deterministically extract subscriber-supplied names from an utterance. HIGH
 * PRECISION on purpose: only names tied to a relationship cue ("my dad Arthur",
 * "Arthur, my dad") or an explicit naming verb ("named/called Arthur", "her
 * name was Mae"). It deliberately does NOT capture bare "that's Arthur" /
 * "this is Arthur" — those snare holidays, places, and objects ("Thanksgiving",
 * "July", "Buick"). Under-capturing is the safe failure: Seth only ever REUSES
 * a captured name as a gentle, correction-open observation, never invents one.
 */
export function extractNamedIdentities(utterance: string): string[] {
  if (!utterance) return [];
  const found: string[] = [];
  const patterns = [
    // "my dad Arthur" / "my aunt, Mae"
    new RegExp(`\\bmy\\s+${RELATIONSHIP}\\s*,?\\s+(${NAME})`, 'g'),
    // "Arthur, my dad" / "Mae — my aunt"
    new RegExp(`\\b(${NAME})\\s*[,—-]\\s*my\\s+${RELATIONSHIP}\\b`, 'g'),
    // "named Arthur" / "called her Mae" / "his name was Arthur" / "her name is Mae"
    // Case-sensitive so NAME stays capitalized; cue initials handled explicitly,
    // and an optional pronoun ("called her Mae") may sit between cue and name.
    new RegExp(`\\b(?:[Nn]amed|[Cc]alled|[Nn]ame\\s+(?:was|is|'s))\\s+(?:her|him|them)?\\s*(${NAME})`, 'g'),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(utterance)) !== null) {
      const name = m[1]?.trim();
      if (name) found.push(name);
    }
  }
  // De-dupe case-insensitively, preserving first-seen order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const n of found) {
    const key = n.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(n);
    }
  }
  return unique;
}

/**
 * Record subscriber-supplied names for intra-session reuse (item D). Adds only
 * names not already known (case-insensitive), stamping the turn first seen.
 * Idempotent when nothing new is found.
 */
export function recordNamedIdentities(
  snapshot: SessionStateSnapshot,
  names: string[],
  turn: number,
): SessionStateSnapshot {
  if (names.length === 0) return snapshot;
  const known = new Set(snapshot.namedIdentities.map((n) => n.name.toLowerCase()));
  const additions = names
    .filter((n) => !known.has(n.toLowerCase()))
    .map((name) => ({ name, firstSeenTurn: turn }));
  if (additions.length === 0) return snapshot;
  return { ...snapshot, namedIdentities: [...snapshot.namedIdentities, ...additions] };
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
