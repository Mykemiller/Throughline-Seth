/**
 * The Hume EVI 3 "custom language model" (BYO-LLM) endpoint.
 *
 * Hume connects here for every assistant turn. Hume owns the voice (transport,
 * STT, prosody, turn-taking, barge-in, TTS); this endpoint owns the brain:
 *
 *   1. DETERMINISTIC reverence pre-filter on the latest subscriber turn, BEFORE
 *      Claude. On a closed-door hit we override Claude entirely and speak one
 *      gentle acknowledgment — this works even if Claude would omit a payload.
 *   2. Otherwise, Claude (consuming sethScaffold) streams Seth's spoken turn,
 *      which we re-emit to Hume as OpenAI-compatible chat-completion chunks.
 *   3. The optional structured payload rides a SEPARATE channel (tool use) and
 *      is staged for a future River write — never spoken, never written here.
 *   4. The flow snapshot (chapter/context) is persisted to
 *      rot_capture_sessions.state_snapshot for recovery.
 *
 * Uttered transcripts (subscriber + companion, with the barge-in `interrupted`
 * flag) are persisted from the browser via /api/exchanges, where the actual
 * spoken/truncated text lives. This endpoint writes only the `system` reverence
 * audit row.
 */
import type { Request, Response } from 'express';
import {
  REVERENCE_ACKNOWLEDGMENT,
  buildSethSystemPrompt,
  closeScope,
  detectClosedDoor,
  advanceChapter,
  spendFollowUp,
  initialStateSnapshot,
  type ClmMessage,
  type ClmRequestBody,
  type SessionStateSnapshot,
} from '@throughline/shared';
import { generateSethTurn } from './claude.js';
import { appendExchange, getSnapshot, updateSession } from './supabase.js';
import { recordClosedTopicEvent, stageDraftPayload } from './riverWrites.js';

/** Emit one OpenAI-style chat.completion.chunk carrying spoken text. */
function sseChunk(res: Response, content: string): void {
  const payload = {
    id: `chatcmpl-ft-${Date.now()}`,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseDone(res: Response): void {
  res.write('data: [DONE]\n\n');
  res.end();
}

function latestSubscriberUtterance(messages: ClmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages[i]!.content;
  }
  return '';
}

export async function handleClmRequest(req: Request, res: Response): Promise<void> {
  const body = req.body as ClmRequestBody;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const sessionId = body?.custom_session_id;

  // SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Barge-in / disconnect → abort the Claude stream.
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  // Load (or initialize) the flow snapshot for this session.
  let snapshot: SessionStateSnapshot =
    (sessionId ? await getSnapshot(sessionId) : null) ?? initialStateSnapshot();

  const utterance = latestSubscriberUtterance(messages);

  // ── P0: deterministic reverence pre-filter (runs BEFORE Claude) ──────────
  const closed = detectClosedDoor(utterance);
  if (closed) {
    snapshot = closeScope(snapshot, closed.phrase);
    if (sessionId) {
      // System-level audit row (not uttered audio) + future durable event (stub).
      await safe(() =>
        appendExchange({
          sessionId,
          role: 'system',
          content: `[reverence] closed-door signal "${closed.matchedText}" → topic closed in chapter ${snapshot.chapterId}`,
        }),
      );
      recordClosedTopicEvent(sessionId, {
        kind: 'closed_topic_event',
        phrase: closed.phrase,
        source: 'reverence_prefilter',
        chapterId: snapshot.chapterId,
      });
      await safe(() => updateSession(sessionId, { snapshot }));
    }
    // Override Claude's next prompt: speak the single gentle acknowledgment.
    sseChunk(res, REVERENCE_ACKNOWLEDGMENT);
    sseDone(res);
    return;
  }

  // ── Normal path: Claude speaks Seth's turn ───────────────────────────────
  const systemPrompt = buildSethSystemPrompt({
    chapterId: snapshot.chapterId,
    followUpSpent: snapshot.followUpSpent,
    closedScopes: snapshot.closedScopes,
    carry: snapshot.carry,
  });

  try {
    const result = await generateSethTurn({
      systemPrompt,
      history: messages,
      chapterId: snapshot.chapterId,
      onText: (delta) => sseChunk(res, delta),
      signal: abort.signal,
    });

    // Structured channel: stage any payload for a future River write (stub).
    if (result.payload && sessionId) {
      if (result.payload.kind === 'closed_topic_event') {
        recordClosedTopicEvent(sessionId, result.payload);
        snapshot = closeScope(snapshot, result.payload.phrase);
      } else {
        stageDraftPayload(sessionId, result.payload);
      }
    }

    // Minimal flow advance (placeholder — THOUG-131 owns real transitions):
    // spend the one follow-up, then advance to the next chapter.
    snapshot = snapshot.followUpSpent ? advanceChapter(snapshot) : spendFollowUp(snapshot);
    if (sessionId) await safe(() => updateSession(sessionId, { snapshot }));

    sseDone(res);
  } catch (err) {
    if (abort.signal.aborted) {
      // Client (Hume) went away — barge-in or hangup. Nothing more to send.
      res.end();
      return;
    }
    console.error('[clm] generation error:', err);
    // Speak a safe, in-character fallback rather than leaking an error.
    sseChunk(res, "I'm sorry — I lost my thread for a moment. Could you say that once more?");
    sseDone(res);
  }
}

/** Run a DB side-effect without letting a write failure crash the turn. */
async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error('[clm] persistence error (non-fatal):', err);
  }
}
