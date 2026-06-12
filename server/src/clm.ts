/**
 * The Hume EVI 3 "custom language model" (BYO-LLM) endpoint — full turn flow.
 *
 * Hume owns the voice (transport, STT, prosody, turn-taking, barge-in, TTS);
 * this endpoint owns the brain. Per-turn order (v0.2 spec §2, §4):
 *
 *   1. DETERMINISTIC reverence pre-filter on the latest subscriber turn,
 *      BEFORE Claude (defense-in-depth #1). On a hit: in-memory block FIRST
 *      (#2), one gentle acknowledgment, durable subscriber_closed_topics row,
 *      snapshot persisted. Claude is never consulted.
 *   2. Pre-prompt gate (#3): the utterance is checked against closed-scope
 *      match_tokens; a touch is treated as subscriber-initiated mention — we
 *      do NOT re-open, Claude is told the door stays closed.
 *   3. Pending-draft confirmation (E13-04): a staged draft + spoken "yes" →
 *      the ONLY path to a River write. Decline discards. Unclear leaves it
 *      staged and lets Seth re-ask naturally.
 *   4. Claude (consuming sethScaffold) streams Seth's spoken turn; an optional
 *      typed payload rides the SEPARATE tool channel (never spoken).
 *   5. chapter_complete payloads advance the engine only if legal (≥1
 *      confirmed Moment in chapter — never forced).
 *   6. Snapshot persisted to rot_capture_sessions.state_snapshot every turn
 *      (E13-08 recovery).
 */
import type { Request, Response } from 'express';
import {
  REVERENCE_ACKNOWLEDGMENT,
  buildSethSystemPrompt,
  applyChapterComplete,
  clearDraft,
  clearPhoto,
  closeScope,
  confirmedInChapter,
  detectClosedDoor,
  detectConfirmation,
  initialStateSnapshot,
  nextTurn,
  spendFollowUp,
  stageDraft,
  recordConfirmedMoment,
  type ClmMessage,
  type ClmRequestBody,
  type SessionStateSnapshot,
} from '@throughline/shared';
import { generateSethTurn } from './claude.js';
import { appendExchange, getSession, updateSession } from './supabase.js';
import { commitMomentDraft, commitStoryDraft, recordClosedTopicEvent } from './riverWrites.js';

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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  // Load session context (who + flow state). Without a session we still speak,
  // but nothing persists and nothing can ever be written.
  const session = sessionId ? await getSession(sessionId) : null;
  let snapshot: SessionStateSnapshot = session?.snapshot ?? initialStateSnapshot();
  const subscriberId = session?.subscriberId ?? null;

  const utterance = latestSubscriberUtterance(messages);
  snapshot = nextTurn(snapshot);

  // ── 1. P0: deterministic reverence pre-filter (BEFORE Claude) ────────────
  const closed = detectClosedDoor(utterance);
  if (closed) {
    // Defense-in-depth #2: block in memory FIRST — before any await, so the
    // next utterance in this session can never race the durable write.
    snapshot = closeScope(snapshot, closed.phrase);
    snapshot = clearDraft(snapshot); // a staged draft on a closed door dies with it
    if (sessionId && subscriberId) {
      await safe(() =>
        appendExchange({
          sessionId,
          role: 'system',
          content: `[reverence] closed-door signal "${closed.matchedText}" → scope closed in chapter ${snapshot.chapterId}`,
        }),
      );
      await safe(() =>
        recordClosedTopicEvent({
          subscriberId,
          sessionId,
          payload: {
            kind: 'closed_topic_event',
            phrase: closed.phrase,
            source: 'reverence_prefilter',
            chapterId: snapshot.chapterId,
          },
          utterance,
        }),
      );
      await safe(() => updateSession(sessionId, { snapshot }));
    }
    sseChunk(res, REVERENCE_ACKNOWLEDGMENT);
    sseDone(res);
    return;
  }

  // ── 3. Pending-draft confirmation (the ONLY path to a River write) ───────
  if (snapshot.pendingDraft && subscriberId && sessionId) {
    const verdict = detectConfirmation(utterance);
    if (verdict === 'confirm') {
      const pending = snapshot.pendingDraft;
      try {
        const committed =
          pending.payload.kind === 'moment_draft'
            ? await commitMomentDraft({
                subscriberId,
                sessionId,
                draft: pending.payload,
                turn: pending.stagedAtTurn,
              })
            : await commitStoryDraft({
                subscriberId,
                sessionId,
                draft: pending.payload,
                turn: pending.stagedAtTurn,
                anchorMomentId: snapshot.pendingPhoto?.momentId ?? snapshot.activeMomentId,
              });
        snapshot = recordConfirmedMoment(snapshot, committed.momentId);
        if (pending.payload.kind === 'story_draft' && snapshot.pendingPhoto) {
          // Photo commentary captured → story committed; unpin the photo.
          snapshot = clearPhoto(snapshot);
        }
        await safe(() =>
          appendExchange({
            sessionId,
            role: 'system',
            content: `[river] confirmed ${pending.payload.kind} "${pending.payload.title}" → moment ${committed.momentId}${committed.merged ? ' (idempotent merge)' : ''}`,
          }),
        );
      } catch (err) {
        console.error('[clm] river commit failed:', err);
      }
    } else if (verdict === 'decline') {
      snapshot = clearDraft(snapshot);
    }
    // 'unclear' → leave staged; Seth re-asks naturally via the prompt context.
  }

  // ── 4. Claude speaks Seth's turn (scaffold-built prompt only) ────────────
  const systemPrompt = buildSethSystemPrompt({
    chapterId: snapshot.chapterId,
    followUpSpent: snapshot.followUpSpent,
    closedScopes: snapshot.closedScopes,
    carry: snapshot.carry,
    pendingDraft: snapshot.pendingDraft,
    pendingPhoto: snapshot.pendingPhoto,
    confirmedInChapter: confirmedInChapter(snapshot),
  });

  try {
    const result = await generateSethTurn({
      systemPrompt,
      history: messages,
      chapterId: snapshot.chapterId,
      onText: (delta) => sseChunk(res, delta),
      signal: abort.signal,
    });

    // ── 5. Structured channel ─────────────────────────────────────────────
    if (result.payload) {
      switch (result.payload.kind) {
        case 'closed_topic_event': {
          snapshot = closeScope(snapshot, result.payload.phrase);
          if (sessionId && subscriberId) {
            const payload = result.payload;
            await safe(() =>
              recordClosedTopicEvent({ subscriberId, sessionId, payload, utterance }),
            );
          }
          break;
        }
        case 'chapter_complete': {
          snapshot = applyChapterComplete(snapshot, result.payload);
          break;
        }
        case 'moment_draft':
        case 'story_draft': {
          // Staged ONLY — committed exclusively on the subscriber's spoken yes.
          snapshot = stageDraft(snapshot, result.payload);
          break;
        }
      }
    }

    // One bounded follow-up per chapter: the first Claude turn after the
    // chapter opens may follow up; mark it spent so the prompt enforces the
    // return to the spine. (The engine resets this on every chapter advance.)
    if (!snapshot.followUpSpent) snapshot = spendFollowUp(snapshot);

    // ── 6. Persist the snapshot every turn (E13-08) ───────────────────────
    if (sessionId) await safe(() => updateSession(sessionId, { snapshot }));

    sseDone(res);
  } catch (err) {
    if (abort.signal.aborted) {
      if (sessionId) await safe(() => updateSession(sessionId, { snapshot }));
      res.end();
      return;
    }
    console.error('[clm] generation error:', err);
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
