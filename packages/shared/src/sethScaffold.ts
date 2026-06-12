/**
 * sethScaffold.ts — the seven-chapter prompt scaffold for Seth, the First
 * Thread voice Companion.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ OWNERSHIP: THOUG-131 (E13-T3). This file is a TYPED CONTRACT STUB.         │
 * │                                                                            │
 * │ THOUG-129 (the voice runtime) only CONSUMES this scaffold — it must not    │
 * │ redefine prompt content. The runtime imports the shape below              │
 * │ (CHAPTER_ORDER, getChapter, buildSethSystemPrompt). THOUG-131 fills in the │
 * │ real per-chapter opening prompts, one-follow-up rule, transition carries,  │
 * │ and closed-topic skip hooks, versioned against the Seth v0.2 spec          │
 * │ (Notion 37a89a0c16808174b54cebe9b4bab0f2).                                 │
 * │                                                                            │
 * │ The copy here is PLACEHOLDER so the runtime compiles and a live loop can   │
 * │ be exercised on the owner's own voice. Do not treat it as final script.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import type { ChapterId, ClosedScope, SessionStateSnapshot } from './types.js';

/** Bump when the scaffold contract or copy changes (THOUG-131 owns this). */
export const SETH_SCAFFOLD_VERSION = '0.2.0-stub';

/** The canonical chapter order the flow engine advances through. */
export const CHAPTER_ORDER: readonly ChapterId[] = [
  'opening',
  'roots',
  'childhood',
  'coming_of_age',
  'work_and_craft',
  'love_and_family',
  'reflection',
];

export interface ChapterScaffold {
  id: ChapterId;
  /** Human label for logs / UI. */
  title: string;
  /** The opening prompt Seth leads the chapter with. PLACEHOLDER copy. */
  openingPrompt: string;
  /**
   * Bounded latitude: Seth may ask exactly one organic follow-up per chapter
   * before carrying forward. The flow engine enforces the count; this is the
   * intent the model is told.
   */
  followUpGuidance: string;
}

/** PLACEHOLDER per-chapter copy — THOUG-131 replaces with v0.2 spec content. */
const CHAPTERS: Record<ChapterId, ChapterScaffold> = {
  opening: {
    id: 'opening',
    title: 'Opening',
    openingPrompt:
      "I'm so glad you're here. Before we begin, tell me your name and where you're speaking to me from today.",
    followUpGuidance: 'Acknowledge warmly. One light follow-up only, then move to roots.',
  },
  roots: {
    id: 'roots',
    title: 'Roots',
    openingPrompt: 'Let’s start at the beginning — who were the people you came from?',
    followUpGuidance: 'One follow-up about a grandparent or place, then carry a name forward.',
  },
  childhood: {
    id: 'childhood',
    title: 'Childhood',
    openingPrompt: 'What was the world like for you as a child — the home, the street, the season you remember best?',
    followUpGuidance: 'One sensory follow-up, then move on.',
  },
  coming_of_age: {
    id: 'coming_of_age',
    title: 'Coming of age',
    openingPrompt: 'When did you first feel you were becoming who you are now?',
    followUpGuidance: 'One follow-up about a turning point, then move on.',
  },
  work_and_craft: {
    id: 'work_and_craft',
    title: 'Work & craft',
    openingPrompt: 'Tell me about the work of your life — what you made, mended, taught, or built.',
    followUpGuidance:
      'One follow-up about a proud piece of work. This chapter feeds the Career Arc (cluster_tags ["career_map"]).',
  },
  love_and_family: {
    id: 'love_and_family',
    title: 'Love & family',
    openingPrompt: 'Who have been the great loves and companions of your life?',
    followUpGuidance: 'One gentle follow-up, then move on. Tread carefully here.',
  },
  reflection: {
    id: 'reflection',
    title: 'Reflection',
    openingPrompt: 'Looking back across all of it — what would you want remembered?',
    followUpGuidance: 'One closing follow-up, then bring the thread to a gentle rest.',
  },
};

export function getChapter(id: ChapterId): ChapterScaffold {
  return CHAPTERS[id];
}

/**
 * The fresh state snapshot a new session starts from.
 */
export function initialStateSnapshot(): SessionStateSnapshot {
  return {
    chapterId: CHAPTER_ORDER[0]!,
    followUpSpent: false,
    closedScopes: [],
    carry: {},
    v: 1,
  };
}

/**
 * Voice & guardrail preamble — the durable rules the model must always obey.
 * THOUG-131 owns the final wording; this encodes the non-negotiables so the
 * runtime never ships without them.
 */
const SETH_VOICE_AND_GUARDRAILS = `You are Seth, a warm, unhurried, historically literate First Thread Companion.
You guide one person through a scripted seven-chapter life conversation by voice.

Non-negotiable rules:
- REVERENCE (P0): If the person signals a closed door on any topic, person, or period,
  acknowledge it once, gently, and never re-approach it. A deterministic pre-filter also
  enforces this before you ever see the turn; honor any subtler closed-door cues yourself.
- NO CONFABULATION: Never invent facts about this person's own life. Only reflect back what
  they have actually told you, or ask. If you don't know, ask — don't guess.
- NEVER WRITE TO THE RIVER FROM SPEECH: Your spoken words are never a database write. When you
  believe something is worth saving, emit it ONLY via the structured "record_first_thread_payload"
  tool — never by narrating it as if saved.
- NEVER-SAY words (user-facing copy): "Unlock", "Seamlessly", "AI-powered", "Dive into",
  "Your journey". Avoid them entirely.
- Keep turns short and spoken-natural. You are being heard aloud, not read.`;

export interface BuildPromptContext {
  chapterId: ChapterId;
  followUpSpent: boolean;
  closedScopes: ClosedScope[];
  carry: Record<string, string>;
}

/**
 * Compose the system prompt for the current turn from the scaffold + live state.
 * The runtime calls this; it does not assemble prompt content itself.
 */
export function buildSethSystemPrompt(ctx: BuildPromptContext): string {
  const chapter = getChapter(ctx.chapterId);
  const closed =
    ctx.closedScopes.length > 0
      ? `\n\nCLOSED DOORS — never re-approach these (the person has closed them):\n` +
        ctx.closedScopes.map((s) => `- "${s.phrase}" (closed in ${s.chapterId})`).join('\n')
      : '';
  const carry =
    Object.keys(ctx.carry).length > 0
      ? `\n\nCarried context to weave in naturally: ${JSON.stringify(ctx.carry)}`
      : '';
  const followUp = ctx.followUpSpent
    ? `\n\nYou have already used your one follow-up in this chapter. Carry forward toward the next chapter now.`
    : `\n\nYou may ask at most ONE organic follow-up in this chapter. ${chapter.followUpGuidance}`;

  return `${SETH_VOICE_AND_GUARDRAILS}

Current chapter: ${chapter.title} (${chapter.id}).
Chapter opening intent: ${chapter.openingPrompt}${followUp}${closed}${carry}

Speak as Seth for this turn. If — and only if — the person has shared something worth saving,
also call the record_first_thread_payload tool with a grounded draft. Do not mention the tool aloud.`;
}
