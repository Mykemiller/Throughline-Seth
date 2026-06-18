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
  /** Schema version for the snapshot shape itself. */
  v: 5;
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
  | IntroCompletePayload;

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
