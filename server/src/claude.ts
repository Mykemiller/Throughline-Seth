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
      kind: { type: 'string', enum: ['moment_draft', 'story_draft', 'closed_topic_event'] },
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

/** Validate/narrow the tool input into a typed FirstThreadPayload. */
function coercePayload(input: unknown, chapterId: ChapterId): FirstThreadPayload | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const kind = o.kind;
  if (kind === 'moment_draft' && typeof o.title === 'string' && typeof o.summary === 'string') {
    return {
      kind,
      title: o.title,
      summary: o.summary,
      whenText: typeof o.whenText === 'string' ? o.whenText : undefined,
      clusterTags: Array.isArray(o.clusterTags) ? (o.clusterTags as string[]) : undefined,
      chapterId,
    };
  }
  if (kind === 'story_draft' && typeof o.title === 'string' && typeof o.body === 'string') {
    return { kind, title: o.title, body: o.body, chapterId };
  }
  if (kind === 'closed_topic_event' && typeof o.phrase === 'string') {
    return { kind, phrase: o.phrase, source: 'claude', chapterId };
  }
  return null;
}
