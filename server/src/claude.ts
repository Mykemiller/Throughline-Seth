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
import type { ChapterId, ClmMessage, FirstThreadPayload, VisionConfidence } from '@throughline/shared';
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
 * Structured vision "review" of a just-added photograph (THOUG-132). Alongside
 * a SHORT literal description, it returns a confidence/validity assessment so
 * the scaffold can gate Beat 0a deterministically (a screenshot, document, or
 * blurry file routes Seth to "did you mean a different picture?" instead of
 * confabulating a memory).
 */
export interface PhotographReview {
  /** One or two plain sentences of ONLY what is literally visible. */
  description?: string;
  /** True if this reads as a real family/personal photo (vs screenshot/doc). */
  isLikelyFamilyPhotograph: boolean;
  /** How clearly the image could be read (low → Beat 0a graceful handling). */
  confidence: VisionConfidence;
}

/**
 * Forced-tool schema for the vision pass. Forcing the tool guarantees a
 * structured verdict instead of free text we'd have to parse.
 */
const PHOTO_REVIEW_TOOL: Anthropic.Tool = {
  name: 'photograph_review',
  description:
    'Report a grounded, literal review of the image artifact only — never an ' +
    'identification, relationship, or backstory.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      isLikelyFamilyPhotograph: {
        type: 'boolean',
        description:
          'True if this reads as a real family/personal photograph; false for a ' +
          'screenshot, document, meme, chart, or otherwise unrelated graphic.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'How clearly you can make the image out. Use "low" if it is blurry, ' +
          'corrupted, or too ambiguous to describe.',
      },
      description: {
        type: 'string',
        description:
          'One or two plain sentences of ONLY what is literally visible — ' +
          'setting, number of people, apparent era from clothing/photo style, ' +
          'objects, mood. No names, no relationships, no backstory. Omit if you ' +
          'cannot make the image out.',
      },
    },
    required: ['isLikelyFamilyPhotograph', 'confidence'],
  },
};

/**
 * Best-effort: returns undefined on any failure so a vision hiccup never blocks
 * the photo pin or the conversation.
 */
export async function describePhotograph(args: {
  strippedJpegBase64: string;
  signal?: AbortSignal;
}): Promise<PhotographReview | undefined> {
  try {
    const message = await client().messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 200,
        system:
          'You help a warm family-history companion notice an old photograph. ' +
          'Assess whether the image is a real family/personal photograph and how ' +
          'clearly you can read it, then describe ONLY what is literally visible. ' +
          'Do NOT name or identify anyone, do NOT guess who they are or their ' +
          'relationships, and do NOT invent any backstory. Report via the ' +
          'photograph_review tool.',
        tools: [PHOTO_REVIEW_TOOL],
        tool_choice: { type: 'tool', name: PHOTO_REVIEW_TOOL.name },
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
              { type: 'text', text: 'Review this photograph.' },
            ],
          },
        ],
      },
      { signal: args.signal },
    );
    const tool = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === PHOTO_REVIEW_TOOL.name,
    );
    if (!tool) return undefined;
    const o = tool.input as Record<string, unknown>;
    const confidence: VisionConfidence =
      o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low'
        ? o.confidence
        : 'low';
    const description = typeof o.description === 'string' ? o.description.trim() : undefined;
    return {
      isLikelyFamilyPhotograph: o.isLikelyFamilyPhotograph === true,
      confidence,
      description: description || undefined,
    };
  } catch (err) {
    // Best-effort: never block the pin. But surface WHY in a single structured
    // line so a swallowed failure is diagnosable from the platform logs — the
    // raw error object serializes unhelpfully on serverless. Includes the model
    // and image size because the usual culprits are an API rejection (bad
    // model/key/permission → has a status + request_id) vs a client-side throw
    // (no status — e.g. a corrupt header), and an oversized image.
    const e = err as {
      name?: string;
      message?: string;
      status?: number;
      request_id?: string;
      requestID?: string;
      error?: { type?: string; error?: { type?: string } };
    };
    console.error(
      '[claude] photo description failed (non-fatal):',
      JSON.stringify({
        model: CLAUDE_MODEL,
        imageBase64Bytes: args.strippedJpegBase64?.length ?? 0,
        name: e?.name,
        status: e?.status ?? null,
        apiErrorType: e?.error?.error?.type ?? e?.error?.type ?? null,
        requestId: e?.request_id ?? e?.requestID ?? null,
        message: e?.message,
      }),
    );
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
