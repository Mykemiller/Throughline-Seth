/**
 * Shared types for the First Thread voice runtime (THOUG-129/131/132).
 *
 * These model the live Supabase schema (migration 005) exactly — do not add
 * fields that aren't columns. Where a column is an enum or has a CHECK
 * constraint, the union here mirrors the DB constraint so the app can't write
 * an invalid value.
 */

/* ── Persistence: first_thread_exchanges ──────────────────────────────────── */

/**
 * role on first_thread_exchanges. DB CHECK:
 *   role = ANY (ARRAY['companion','subscriber','system'])
 */
export type ExchangeRole = 'companion' | 'subscriber' | 'system';

/** A row in first_thread_exchanges. Audio is NEVER stored. */
export interface FirstThreadExchange {
  id: string;
  session_id: string;
  role: ExchangeRole;
  /** Only what was actually uttered. Never the full intended text on a barge-in. */
  content: string;
  /** True when this turn was truncated by a barge-in / user interruption. */
  interrupted: boolean;
  created_at: string;
}

export interface NewExchange {
  session_id: string;
  role: ExchangeRole;
  content: string;
  interrupted?: boolean;
}

/* ── Persistence: rot_capture_sessions ────────────────────────────────────── */

export type SessionStatus = 'in_progress' | 'complete' | 'abandoned';
/** Arc phase of a First Thread session: spoken intro, then the seven-chapter walk. */
export type SessionPhase = 'intro' | 'walk';
export type EntryPoint = 'first_thread';
export type Companion = 'seth' | 'miriam';

/* ── Persistence: subscriber_closed_topics ────────────────────────────────── */

/** enum closed_topic_signal */
export type ClosedTopicSignal = 'closed_door' | 'light_deflection';
/** enum closed_topic_status */
export type ClosedTopicStatus = 'closed' | 'revisit_ok' | 'revisit_requested';

/* ── Seven-chapter flow (THOUG-131, per Seth v0.2 spec — spec spine is canon) ─ */

/**
 * The seven chapters of the First Thread walk, per the locked v0.2 spec:
 * First Light → The School Years → Becoming → The World You Built →
 * What Stayed → Still Becoming → Last Night.
 * Chapters 1–3 are the Core Session; 4–7 are Depth Sessions.
 */
export type ChapterId =
  | 'first_light'
  | 'school_years'
  | 'becoming'
  | 'world_you_built'
  | 'what_stayed'
  | 'still_becoming'
  | 'last_night';

/** McAdams nuclear episode types each chapter hunts for. */
export type NuclearEpisode = 'first_memory' | 'high_point' | 'low_point' | 'turning_point';

/** Career Arc acts (flat cluster_tags ['career_map'], never a tree). */
export type CareerArcAct = 'origin' | 'build' | 'legacy';

export interface ClosedScope {
  /** The matched phrase / topic that triggered the close (for audit). */
  phrase: string;
  /**
   * Normalized match tokens for the pre-prompt gate (mirrors
   * subscriber_closed_topics.match_tokens). Exact-match against tokens —
   * never fuzzy.
   */
  matchTokens: string[];
  /** ISO timestamp the scope was closed. */
  closedAt: string;
  /** Chapter the close happened in. */
  chapterId: ChapterId;
}

/**
 * A staged draft awaiting the subscriber's spoken confirmation (E13-04).
 * NOTHING is written to the River until this is confirmed aloud.
 */
export interface PendingDraft {
  payload: MomentDraftPayload | StoryDraftPayload;
  /** Turn number the draft was staged on (feeds the idempotency key). */
  stagedAtTurn: number;
}

/**
 * A subscriber-supplied identity, captured deterministically from speech for
 * intra-session reuse (deferred item D). Seth may reuse a name the subscriber
 * gave THIS session when a face plausibly reappears — he still never invents or
 * guesses an identity. `firstSeenTurn` lets the recap reference when it arrived.
 */
export interface NamedIdentity {
  /** The name exactly as the subscriber gave it. */
  name: string;
  /** Turn the subscriber first named this person (audit + recap ordering). */
  firstSeenTurn: number;
}

/** How clearly the vision pass could read the image (Beat 0a gating). */
export type VisionConfidence = 'high' | 'medium' | 'low';

/* ── Photo Walk (THOUG-132 v0.3): three-beat dialogue + name matching ──────── */

/**
 * The three content beats every shared photo covers before its thread closes
 * (AC10). Subscriber-led order — all three must be touched (offered counts;
 * a gentle decline still covers a beat), but never interrogated in sequence.
 */
export interface PhotoBeats {
  /** Memories → captured as a Layer 3 Story anchored via cluster_root_id. */
  memories: boolean;
  /** Time & place → EXIF prefill, gently confirmed conversationally. */
  timePlace: boolean;
  /** Who's in it → names matched against `persons`. */
  people: boolean;
}

/** AC11 name-resolution tiers against `persons` (mirrors photo_persons CHECK). */
export type PersonMatchConfidence = 'exact' | 'fuzzy' | 'ambiguous' | 'unmatched';

/**
 * A one-and-done disambiguation in flight (D4): a spoken name matched more
 * than one `persons` candidate; Seth asks exactly ONE clarifying question. If
 * the next reply doesn't resolve it, the row stays 'ambiguous' and we move on.
 */
export interface PendingNameClarification {
  /** The name as the subscriber spoke it. */
  displayName: string;
  /** photo_persons row already written for this name (person_id updated on resolve). */
  photoPersonId: string | null;
  /** Candidate persons ids still in contention. */
  candidateIds: string[];
  /** Short spoken-safe summaries ("Ruth Morgan, born 1902") for the one question. */
  candidateSummaries: string[];
  /**
   * 0 while armed but not yet spoken; stamped with the turn number when the
   * question goes out. The next reply after that turn is its answer (one-shot).
   */
  askedTurn: number;
}

/**
 * A photo shared BEFORE any Moment exists (e.g. during the Introduction). Its
 * bytes are already in Storage and it has been vision-analyzed, but no
 * `media_assets` row can be written yet (moment_id is NOT NULL). It is held in
 * the snapshot so Seth can already "see" and acknowledge it, then materialized
 * into a pinned PendingPhoto the moment the first Moment of the session is
 * created. The image bytes are NOT stored here — only the Storage URL + the
 * grounded vision review.
 */
export interface HeldPhoto {
  /** Storage URL of the EXIF-stripped derivative already uploaded. */
  storageUrl: string;
  /** Whether the untouched original was retained (opt-in). */
  retainOriginal: boolean;
  whenText?: string;
  whereText?: string;
  description?: string;
  isLikelyPhoto?: boolean;
  visionConfidence?: VisionConfidence;
}

/** A photo pinned mid-session, awaiting spoken commentary (E13-05/06). */
export interface PendingPhoto {
  assetId: string;
  momentId: string;
  /** Validated text metadata extracted client-side (EXIF parsed in browser). */
  whenText?: string;
  whereText?: string;
  /**
   * A short, grounded vision "review" of what is visibly in the photo — an
   * observation of the image artifact only (never an identification or
   * backstory). Lets Seth gently reference the picture; he still proposes,
   * never asserts.
   */
  description?: string;
  /**
   * Vision-confidence gate (Beat 0a). `isLikelyPhoto === false` or
   * `visionConfidence === 'low'` routes Seth to the graceful non-photo
   * acknowledgment ("did you mean a different picture?") instead of describing.
   * Both are undefined when the vision pass was skipped or failed — in that
   * case Seth acknowledges the photo warmly without inventing a description.
   */
  isLikelyPhoto?: boolean;
  visionConfidence?: VisionConfidence;
  /**
   * Photo Walk (AC10): which of the three beats this photo has covered.
   * Absent on photos pinned before v6 — treated as none covered.
   */
  beats?: PhotoBeats;
  /**
   * Reverence Dead-End Trigger (P0): a name tied to this photo touched a
   * closed topic. The who's-in-it beat is bypassed entirely — no prompting,
   * no acknowledgment, no near-miss phrasing. Set only by the deterministic
   * server-relay check, never by the model.
   */
  peopleSuppressed?: boolean;
  /** Turn this photo came into focus (safety valve for a stuck thread). */
  focusedAtTurn?: number;
}

/**
 * state_snapshot (jsonb) on rot_capture_sessions — the flow-engine node +
 * context, persisted every turn for crash/barge-in/drop recovery (E13-08).
 */
export interface SessionStateSnapshot {
  chapterId: ChapterId;
  /** Whether the current chapter has already spent its one bounded follow-up. */
  followUpSpent: boolean;
  /** Monotonic turn counter for the session (feeds sync_idempotency_key). */
  turn: number;
  /** Closed-door scopes — once closed, never re-approached. */
  closedScopes: ClosedScope[];
  /** One concrete detail carried across chapter transitions. */
  carry: Record<string, string>;
  /** Draft staged on the structured channel, awaiting spoken confirmation. */
  pendingDraft: PendingDraft | null;
  /** Photo pinned and awaiting the subscriber's spoken commentary. */
  pendingPhoto: PendingPhoto | null;
  /**
   * moment_id of the Moment in focus — the photo pin target and story anchor.
   * Set as soon as a Moment is written ambiently (pending_review), so a photo
   * can attach without waiting for recap confirmation; also set on recap
   * confirmation. Null until the first Moment of the session exists.
   */
  activeMomentId: string | null;
  /** Count of confirmed Moments per chapter (chapter completeness rule). */
  confirmedMoments: Partial<Record<ChapterId, number>>;
  /**
   * Where the session is in its arc. `intro` = Seth's spoken introduction +
   * name capture (runs once, before First Light); `walk` = the seven-chapter
   * walk. New sessions start in `intro`; legacy snapshots revive as `walk`.
   */
  phase: SessionPhase;
  /** The subscriber's spoken name, captured in the intro (null until given). */
  subscriberName: string | null;
  /**
   * True while Seth has surfaced pending_review Moments at a recap and is
   * awaiting the subscriber's batch verdict (v0.3 Ambient Write + Timed Recap).
   */
  recapPending: boolean;
  /**
   * Set at session open when the subscriber has committed Moments from a prior
   * session — Seth speaks a brief next-session recap before resuming the walk.
   */
  nextSessionRecapPending: boolean;
  /* ── Photo-series state (v5; reserved for deferred items A/B/D) ──────────── */
  /**
   * (A — batch intake) Photos that arrived together but beyond the one Seth
   * anchored on. Drained one at a time through the photo beats; the head
   * becomes the next `pendingPhoto`. Empty when there is no batch in flight.
   */
  photoQueue: PendingPhoto[];
  /**
   * (B — soft photo cap) Photos seen since the last recap fired. Drives the
   * ~5-photo soft-cap recap trigger; reset to 0 when a recap fires.
   */
  photosSinceRecap: number;
  /**
   * (B — idle timeout) ISO timestamp of the last subscriber turn. On return,
   * `now − lastActivityAt` past the idle threshold marks an operational
   * timeout (a gentle re-entry nudge), never a closed door. Null until set.
   */
  lastActivityAt: string | null;
  /**
   * (D — intra-session identity) Names the subscriber has supplied this
   * session, for gentle reuse when a face reappears. Captured deterministically
   * from speech; never invented. Empty until the subscriber names someone.
   */
  namedIdentities: NamedIdentity[];
  /**
   * Photos shared before any Moment existed (e.g. during the Introduction):
   * already uploaded + vision-analyzed, awaiting the first Moment so a
   * media_assets row can be written. Materialized into pendingPhoto/photoQueue
   * the moment one is created. Empty in the common case.
   */
  heldPhotos: HeldPhoto[];
  /* ── Photo Walk state (v6, THOUG-132) ─────────────────────────────────────── */
  /**
   * (AC8/D5) Chapters where the once-per-chapter photo ask was DECLINED.
   * Chapter-scoped suppression, NOT a Reverence closure — never written to
   * subscriber_closed_topics. Persists across sessions (carried forward into
   * new sessions by createSession).
   */
  photoDeclinedChapters: ChapterId[];
  /** (AC8) Chapters where the photo ask has already been made — never re-asked. */
  photoAskedChapters: ChapterId[];
  /**
   * (AC8) The photo ask is due: armed on chapter entry, consumed by the next
   * prompt build so the ask lands EARLY — within the first exchanges.
   */
  photoAskPending: boolean;
  /**
   * (AC8) The ask went out last turn; the next subscriber reply is read for a
   * decline (photo_ask_outcome on the tool channel). One-shot.
   */
  photoAskAwaitingReply: boolean;
  /** (D4) One-and-done name disambiguation in flight, if any. */
  pendingNameClarification: PendingNameClarification | null;
  /** Schema version for the snapshot shape itself. */
  v: 6;
}

/* ── Two-channel structured output (the River-write boundary) ──────────────── */

/**
 * Each relevant Claude turn yields two channels:
 *   1. spoken text  → goes to Hume for TTS (the only thing the subscriber hears)
 *   2. an OPTIONAL typed payload → never spoken; the seed for a River write,
 *      committed ONLY after the subscriber confirms aloud (E13-04).
 */
export type FirstThreadPayload =
  | MomentDraftPayload
  | StoryDraftPayload
  | ClosedTopicEventPayload
  | ChapterCompletePayload
  | IntroCompletePayload
  | PhotoDetailsPayload
  | PhotoAskOutcomePayload;

/**
 * Photo Walk (AC10/AC11): grounded details the subscriber gave about the photo
 * in focus, captured on the tool channel as they arrive — never invented.
 * Drives beat tracking, place_text capture, and persons matching.
 */
export interface PhotoDetailsPayload {
  kind: 'photo_details';
  /** When the moment happened, as the subscriber placed it ("summer of 1974"). */
  whenText?: string;
  /** Where it was, as spoken — free text (D2; no gazetteer). */
  placeText?: string;
  /** People the subscriber named as being IN this photo — their words only. */
  personNames?: string[];
  /** The subscriber indicated no one to name / didn't want to name anyone. */
  noPeople?: boolean;
  /**
   * The model attests all three beats have been touched (offered counts) and
   * the photo's thread feels complete — releases the photo from focus.
   */
  threadComplete?: boolean;
  chapterId: ChapterId;
}

/**
 * AC8: the subscriber declined this chapter's photo ask. Chapter-scoped
 * suppression only (D5) — never a Reverence closure.
 */
export interface PhotoAskOutcomePayload {
  kind: 'photo_ask_outcome';
  outcome: 'declined';
  chapterId: ChapterId;
}

export interface MomentDraftPayload {
  kind: 'moment_draft';
  title: string;
  /** The grounded summary Seth proposes committing — subscriber's words only. */
  summary: string;
  /** Approximate period/date text as spoken (not parsed to a date). */
  whenText?: string;
  /** McAdams scene-type tag, when clear. */
  sceneType?: NuclearEpisode | 'life_script_event';
  /** Career Arc clustering (flat cluster_tags, e.g. ['career_map']). */
  clusterTags?: string[];
  chapterId: ChapterId;
}

export interface StoryDraftPayload {
  kind: 'story_draft';
  title: string;
  /** Longer-form narrative draft, grounded in the subscriber's own telling. */
  body: string;
  chapterId: ChapterId;
}

/**
 * Emitted when a closed-door signal is honored. Produced deterministically by
 * the pre-filter (authoritative) and may ALSO be surfaced by Claude.
 */
export interface ClosedTopicEventPayload {
  kind: 'closed_topic_event';
  phrase: string;
  source: 'reverence_prefilter' | 'claude';
  chapterId: ChapterId;
}

/**
 * Emitted once, during the intro phase, when Seth has the subscriber's name and
 * is ready to begin First Light. The engine stores the name and flips the
 * session from `intro` to `walk`.
 */
export interface IntroCompletePayload {
  kind: 'intro_complete';
  /** The subscriber's name as they gave it (used warmly through the walk). */
  name: string;
}

/**
 * Claude signals the current chapter has what it needs (≥1 confirmed Moment;
 * never forced). The engine — not Claude — decides whether the advance is
 * legal (order, completeness).
 */
export interface ChapterCompletePayload {
  kind: 'chapter_complete';
  chapterId: ChapterId;
  /** One concrete detail to carry into the next chapter's transition. */
  carryDetail?: string;
}

/* ── CLM transport (Hume BYO-LLM ↔ Claude) ────────────────────────────────── */

export interface ClmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ClmRequestBody {
  messages: ClmMessage[];
  custom_session_id?: string;
  model?: string;
  stream?: boolean;
}
