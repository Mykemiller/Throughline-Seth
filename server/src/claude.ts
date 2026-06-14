/**
 * Claude as the BYO-LLM. Claude does the reasoning and speaks Seth's turn; Hume
 * handles the voice. We stream Claude's TEXT (the spoken channel) token-by-token
 * so Hume can begin TTS immediately, and we collect an OPTIONAL typed payload on
 * a SEPARATE channel via tool use — the payload is never spoken.
 *
 * Latency: this is a live voice turn, so we disable thinking and keep turns
 * short. Model defaults to claude-opus-4-8 (see env.CLAUDE_MODEL).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ChapterId, ClmMessage, FirstThreadPayload } from '@throughline/shared';
import { CLAUDE_MODEL, requireSecrets } from './env.js';

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  if (anthropic) return anthropic;
  anthropic = new Anthropic({ apiKey: requireSecrets().ANTHROPIC_API_KEY });
  return anthropic;
}

/**
 * The structured-output tool. This is the ONLY way a turn can propose a River
 * write — the spoken text never is. Strict schema so the payload validates.
 */
const RECORD_PAYLOAD_TOOL: Anthropic.Tool = {
  name: 'record_first_thread_payload',
  description:
    'Record a structured draft worth saving from what the person actually said. ' +
    'Call this ONLY when the person has shared something concrete worth preserving. ' +
    'Never mention this tool aloud. This does not save anything by itself — it is a draft for later confirmation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string',
        enum: ['moment_draft', 'story_draft', 'closed_topic_event', 'chapter_complete', 'intro_complete'],
      },
      title: { type: 'string', description: 'Short title (moment_draft / story_draft).' },
      summary: { type: 'string', description: 'Grounded summary (moment_draft).' },
      body: { type: 'string', description: 'Longer narrative (story_draft).' },
      whenText: { type: 'string', description: 'Approximate period as spoken; not a parsed date.' },
      clusterTags: {
        type: 'array',
        items: { type: 'string' },
        description: "Career Arc clustering hint, e.g. ['career_map'].",
      },
      phrase: { type: 'string', description: 'Closed-door phrase (closed_topic_event).' },
      sceneType: {
        type: 'string',
        enum: ['first_memory', 'high_point', 'low_point', 'turning_point', 'life_script_event'],
        description: 'McAdams scene-type tag for a moment_draft, when clear.',
      },
      carryDetail: {
        type: 'string',
        description: 'chapter_complete: one concrete detail to carry into the next chapter.',
      },
      name: {
        type: 'string',
        description: "intro_complete: the subscriber's name as they gave it.",
      },
    },
    required: ['kind'],
  },
};

export interface SethTurnResult {
  /** The full spoken text Claude generated (already streamed via onText). */
  spokenText: string;
  /** Optional payload on the structured channel — never spoken. */
  payload: FirstThreadPayload | null;
  /** Why generation stopped (for diagnostics). */
  stopReason: string | null;
}

/**
 * Generate Seth's turn. `onText` receives spoken text deltas as they arrive so
 * the caller can forward them to Hume immediately.
 */
export async function generateSethTurn(args: {
  systemPrompt: string;
  history: ClmMessage[];
  chapterId: ChapterId;
  onText: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<SethTurnResult> {
  const messages: Anthropic.MessageParam[] = args.history
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const stream = client().messages.stream(
    {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      // Live voice turn: keep it snappy. Disable thinking and ask for a
      // final-answer-only spoken reply so reasoning doesn't leak into speech.
      thinking: { type: 'disabled' },
      system: args.systemPrompt,
      tools: [RECORD_PAYLOAD_TOOL],
      messages,
    },
    { signal: args.signal },
  );

  stream.on('text', (delta) => args.onText(delta));

  const final = await stream.finalMessage();

  let spokenText = '';
  let payload: FirstThreadPayload | null = null;
  for (const block of final.content) {
    if (block.type === 'text') {
      spokenText += block.text;
    } else if (block.type === 'tool_use' && block.name === RECORD_PAYLOAD_TOOL.name) {
      payload = coercePayload(block.input, args.chapterId);
    }
  }

  return { spokenText, payload, stopReason: final.stop_reason };
}

/**
 * Vision "review" of a just-added photograph (THOUG-132). Produces a SHORT,
 * literal description of what is *visibly* in the EXIF-stripped derivative so
 * Seth can gently reference it — never to assert identities or invent facts
 * about the person's life (No-confabulation rule). The description is an
 * observation of the image artifact only; Seth still proposes, never asserts.
 *
 * Best-effort: returns undefined on any failure so a vision hiccup never blocks
 * the photo pin or the conversation.
 */
export async function describePhotograph(args: {
  strippedJpegBase64: string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  try {
    const message = await client().messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 160,
        system:
          'You help a warm family-history companion notice an old photograph. ' +
          'Describe ONLY what is literally visible in the image in one or two plain ' +
          'sentences — setting, number of people, apparent era from clothing/photo style, ' +
          'objects, mood. Do NOT name or identify anyone, do NOT guess who they are or ' +
          'their relationships, and do NOT invent any backstory. If something is unclear, ' +
          'say so plainly. Keep it short and neutral.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: args.strippedJpegBase64,
                },
              },
              { type: 'text', text: 'What is visibly in this photograph?' },
            ],
          },
        ],
      },
      { signal: args.signal },
    );
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return text || undefined;
  } catch (err) {
    console.error('[claude] photo description failed (non-fatal):', err);
    return undefined;
  }
}

/** Validate/narrow the tool input into a typed FirstThreadPayload. */
function coercePayload(input: unknown, chapterId: ChapterId): FirstThreadPayload | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const kind = o.kind;
  if (kind === 'moment_draft' && typeof o.title === 'string' && typeof o.summary === 'string') {
    const scenes = ['first_memory', 'high_point', 'low_point', 'turning_point', 'life_script_event'];
    return {
      kind,
      title: o.title,
      summary: o.summary,
      whenText: typeof o.whenText === 'string' ? o.whenText : undefined,
      sceneType:
        typeof o.sceneType === 'string' && scenes.includes(o.sceneType)
          ? (o.sceneType as import('@throughline/shared').MomentDraftPayload['sceneType'])
          : undefined,
      clusterTags: Array.isArray(o.clusterTags) ? (o.clusterTags as string[]) : undefined,
      chapterId,
    };
  }
  if (kind === 'chapter_complete') {
    return {
      kind,
      chapterId,
      carryDetail: typeof o.carryDetail === 'string' ? o.carryDetail : undefined,
    };
  }
  if (kind === 'story_draft' && typeof o.title === 'string' && typeof o.body === 'string') {
    return { kind, title: o.title, body: o.body, chapterId };
  }
  if (kind === 'closed_topic_event' && typeof o.phrase === 'string') {
    return { kind, phrase: o.phrase, source: 'claude', chapterId };
  }
  if (kind === 'intro_complete' && typeof o.name === 'string' && o.name.trim() !== '') {
    return { kind, name: o.name.trim() };
  }
  return null;
}
