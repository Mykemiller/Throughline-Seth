/**
 * The Hume EVI 3 "custom language model" (BYO-LLM) endpoint — full turn flow.
 *
 * v0.3 — Ambient Write + Timed Recap model (2026-06-14, THOUG-132)
 *
 * Hume owns the voice (transport, STT, prosody, turn-taking, barge-in, TTS);
 * this endpoint owns the brain. Per-turn order:
 *
 *   1. DETERMINISTIC reverence pre-filter on the latest subscriber turn,
 *      BEFORE Claude (defense-in-depth #1). On a hit: in-memory block FIRST
 *      (#2), one gentle acknowledgment, durable subscriber_closed_topics row,
 *      snapshot persisted. Claude is never consulted.
 *   2. Pre-prompt gate (#3): the utterance is checked against closed-scope
 *      match_tokens; a touch is treated as subscriber-initiated mention — we
 *      do NOT re-open, Claude is told the door stays closed.
 *   3. RECAP CHECK — fires BEFORE Claude if either recap trigger is active:
 *      a. Chapter boundary: snapshot.chapterId changed since last turn
 *      b. 20-min elapsed: now - session.recap_last_at > 20 minutes (or null)
 *      Seth speaks the recap prompt; pending_review rows are surfaced. On the
 *      subscriber's NEXT turn, their response (confirm/drop/closed-door) is
 *      processed before Claude runs again.
 *   4. RECAP RESPONSE processing — if snapshot.recapPending is true and the
 *      subscriber just responded, process their confirm/drop/closed-door
 *      verdicts, commit or drop rows, clear recapPending.
 *   5. Claude (consuming sethScaffold) streams Seth's spoken turn; an optional
 *      typed payload rides the SEPARATE tool channel (never spoken).
 *      moment_draft / story_draft → writeAmbientMoment/Story() immediately
 *      (no mid-conversation confirmation request).
 *   6. chapter_complete payloads advance the engine only if legal (≥1
 *      committed Moment in chapter — never forced).
 *   7. Snapshot persisted to rot_capture_sessions.state_snapshot every turn
 *      (E13-08 recovery).
 *
 * NEXT-SESSION RECAP: at session open (turn 1, phase='walk', prior session
 * exists with committed moments), Seth speaks the prior-session recap before
 * proceeding. This is set via snapshot.nextSessionRecapPending on initialise.
 */
import type { Request, Response } from 'express';
import {
  REVERENCE_ACKNOWLEDGMENT,
  buildSethSystemPrompt,
  buildSethIntroPrompt,
  applyChapterComplete,
  applyIntroComplete,
  clearDraft,
  clearPhoto,
  closeScope,
  confirmedInChapter,
  detectClosedDoor,
  detectConfirmation,
  initialStateSnapshot,
  nextTurn,
  setActiveMoment,
  spendFollowUp,
  stageDraft,
  recordConfirmedMoment,
  type ClmMessage,
  type ClmRequestBody,
  type SessionStateSnapshot,
} from '@throughline/shared';
import { generateSethTurn } from './claude.js';
import { appendExchange, getSession, updateSession } from './supabase.js';
import {
  buildMidSessionRecapPrompt,
  buildNextSessionRecapPrompt,
  commitMomentDraft,
  commitPendingReview,
  commitStoryDraft,
  dropPendingReview,
  getPendingReviewRows,
  getPriorSessionMoments,
  markRecapFired,
  recordClosedTopicEvent,
  writeAmbientMoment,
  writeAmbientStory,
} from './riverWrites.js';

/** 20 minutes in milliseconds — the time-based recap trigger. */
const RECAP_INTERVAL_MS = 20 * 60 * 1000;

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

/** True if 20+ minutes have elapsed since the last recap (or no recap ever). */
function recapTimeElapsed(recapLastAt: string | null): boolean {
  if (!recapLastAt) return false; // no recap yet — we fire on chapter boundary first
  return Date.now() - new Date(recapLastAt).getTime() > RECAP_INTERVAL_MS;
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

  const session = sessionId ? await getSession(sessionId) : null;
  let snapshot: SessionStateSnapshot = session?.snapshot ?? initialStateSnapshot();
  const subscriberId = session?.subscriberId ?? null;

  const utterance = latestSubscriberUtterance(messages);
  const previousChapterId = snapshot.chapterId;
  snapshot = nextTurn(snapshot);

  // ── 1. P0: deterministic reverence pre-filter (BEFORE Claude) ────────────
  const closed = detectClosedDoor(utterance);
  if (closed) {
    snapshot = closeScope(snapshot, closed.phrase);
    snapshot = clearDraft(snapshot);

    // If we're in a recap and the subscriber closed a topic on a pending row,
    // find and drop the matching pending_review row.
    if (snapshot.recapPending && subscriberId && sessionId) {
      const pendingRows = await safe(() =>
        getPendingReviewRows({ subscriberId, sessionId }),
      ) ?? [];
      const matchingRow = pendingRows.find(
        (r) => r.title.toLowerCase().includes(closed.phrase.toLowerCase()),
      );
      if (matchingRow) {
        await safe(() => dropPendingReview(matchingRow.momentId));
        await safe(() =>
          appendExchange({
            sessionId,
            role: 'system',
            content: `[recap/reverence] dropped pending_review "${matchingRow.title}" on closed-door signal`,
          }),
        );
      }
    }

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

  // ── 2. Intro phase ────────────────────────────────────────────────────────
  if (snapshot.phase === 'intro') {
    const introPrompt = buildSethIntroPrompt({ subscriberName: snapshot.subscriberName });
    try {
      const result = await generateSethTurn({
        systemPrompt: introPrompt,
        history: messages,
        chapterId: snapshot.chapterId,
        onText: (delta) => sseChunk(res, delta),
        signal: abort.signal,
      });
      if (result.payload?.kind === 'intro_complete') {
        snapshot = applyIntroComplete(snapshot, result.payload);
        if (sessionId && subscriberId) {
          await safe(() =>
            appendExchange({
              sessionId,
              role: 'system',
              content: `[intro] name captured → "${snapshot.subscriberName ?? ''}"; entering ${snapshot.chapterId}`,
            }),
          );
        }
      }
      if (sessionId) await safe(() => updateSession(sessionId, { snapshot }));
      sseDone(res);
    } catch (err) {
      if (abort.signal.aborted) {
        if (sessionId) await safe(() => updateSession(sessionId, { snapshot }));
        res.end();
        return;
      }
      console.error('[clm] intro generation error:', err);
      sseChunk(res, "I'm sorry — I lost my thread for a moment. Could you say that once more?");
      sseDone(res);
    }
    return;
  }

  // ── 3. Next-session recap (turn 1 of a new session, prior moments exist) ──
  // Fires once per new session, before any chapter work. Seth speaks the recap
  // then waits for a natural "yes, carry on" before proceeding.
  if (snapshot.nextSessionRecapPending && subscriberId && sessionId) {
    const verdict = detectConfirmation(utterance);
    if (verdict === 'confirm' || snapshot.turn > 1) {
      // Subscriber acknowledged — clear the flag and fall through to normal flow.
      snapshot = { ...snapshot, nextSessionRecapPending: false };
    } else {
      // First utterance of the session — speak the next-session recap.
      const priorMoments = await safe(() =>
        getPriorSessionMoments({ subscriberId, currentSessionId: sessionId }),
      ) ?? [];
      if (priorMoments.length > 0) {
        const recapText = buildNextSessionRecapPrompt(priorMoments);
        sseChunk(res, recapText);
        await safe(() =>
          appendExchange({
            sessionId,
            role: 'system',
            content: `[recap/next-session] surfaced ${priorMoments.length} prior committed moments`,
          }),
        );
        await safe(() => updateSession(sessionId, { snapshot }));
        sseDone(res);
        return;
      }
      // No prior moments — nothing to recap; clear flag and proceed.
      snapshot = { ...snapshot, nextSessionRecapPending: false };
    }
  }

  // ── 4. Recap response processing ──────────────────────────────────────────
  // If the previous turn triggered a mid-session recap, process the
  // subscriber's response before consulting Claude.
  if (snapshot.recapPending && subscriberId && sessionId) {
    const pendingRows = await safe(() =>
      getPendingReviewRows({ subscriberId, sessionId }),
    ) ?? [];

    const verdict = detectConfirmation(utterance);

    if (verdict === 'confirm' || utterance.trim() === '') {
      // Confirm all pending_review rows.
      if (pendingRows.length > 0) {
        const ids = pendingRows.map((r) => r.momentId);
        await safe(() => commitPendingReview(ids));
        for (const row of pendingRows) {
          snapshot = recordConfirmedMoment(snapshot, row.momentId);
        }
        await safe(() =>
          appendExchange({
            sessionId,
            role: 'system',
            content: `[recap] confirmed ${ids.length} moments: ${pendingRows.map((r) => r.title).join(', ')}`,
          }),
        );
      }
      snapshot = { ...snapshot, recapPending: false };
    } else if (verdict === 'decline') {
      // Drop all pending rows (subscriber rejected the batch).
      for (const row of pendingRows) {
        await safe(() => dropPendingReview(row.momentId));
      }
      await safe(() =>
        appendExchange({
          sessionId,
          role: 'system',
          content: `[recap] subscriber declined batch — dropped ${pendingRows.length} pending_review rows`,
        }),
      );
      snapshot = { ...snapshot, recapPending: false };
    }
    // 'unclear' → leave recapPending=true; Seth re-asks gently via prompt context.
  }

  // ── 5. Mid-session recap trigger check ───────────────────────────────────
  // Fires at the EARLIER of chapter boundary or 20-min elapsed.
  // Does not fire if a recap is already pending.
  if (!snapshot.recapPending && subscriberId && sessionId) {
    const chapterBoundary = snapshot.chapterId !== previousChapterId;
    const timeElapsed = recapTimeElapsed(session?.recapLastAt ?? null);

    if ((chapterBoundary || timeElapsed) && snapshot.turn > 1) {
      const pendingRows = await safe(() =>
        getPendingReviewRows({ subscriberId, sessionId }),
      ) ?? [];

      if (pendingRows.length > 0) {
        const recapText = buildMidSessionRecapPrompt(pendingRows);
        sseChunk(res, recapText);
        snapshot = { ...snapshot, recapPending: true };
        await safe(() => markRecapFired(sessionId));
        await safe(() =>
          appendExchange({
            sessionId,
            role: 'system',
            content: `[recap] ${chapterBoundary ? 'chapter boundary' : '20-min elapsed'} — surfaced ${pendingRows.length} pending_review rows for confirmation`,
          }),
        );
        await safe(() => updateSession(sessionId, { snapshot }));
        sseDone(res);
        return;
      }

      // No pending rows to recap — still mark fired to reset the timer.
      if (timeElapsed) await safe(() => markRecapFired(sessionId));
    }
  }

  // ── 6. Claude speaks Seth's turn ──────────────────────────────────────────
  const systemPrompt = buildSethSystemPrompt({
    chapterId: snapshot.chapterId,
    subscriberName: snapshot.subscriberName,
    followUpSpent: snapshot.followUpSpent,
    closedScopes: snapshot.closedScopes,
    carry: snapshot.carry,
    pendingDraft: snapshot.pendingDraft,
    pendingPhoto: snapshot.pendingPhoto,
    confirmedInChapter: confirmedInChapter(snapshot),
    recapPending: snapshot.recapPending,
  });

  try {
    const result = await generateSethTurn({
      systemPrompt,
      history: messages,
      chapterId: snapshot.chapterId,
      onText: (delta) => sseChunk(res, delta),
      signal: abort.signal,
    });

    // ── 7. Structured channel ─────────────────────────────────────────────
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
        case 'moment_draft': {
          // AMBIENT WRITE — no confirmation gate. River row lands immediately
          // as pending_review. Recap surface handles confirmation.
          if (subscriberId && sessionId) {
            const written = await safe(() =>
              writeAmbientMoment({
                subscriberId,
                sessionId,
                draft: result.payload as any,
                turn: snapshot.turn,
              }),
            );
            if (written) {
              // Make the ambient Moment the pin target NOW so a photo can
              // attach immediately (it doesn't wait for recap confirmation).
              // This does NOT count toward chapter completeness — that still
              // requires the subscriber's recap confirmation.
              snapshot = setActiveMoment(snapshot, written.momentId);
              await safe(() =>
                appendExchange({
                  sessionId,
                  role: 'system',
                  content: `[river/ambient] moment_draft "${(result.payload as any).title}" → pending_review ${written.momentId} (active pin target)`,
                }),
              );
            }
          }
          // Keep draft in snapshot for recap reference.
          snapshot = stageDraft(snapshot, result.payload);
          break;
        }
        case 'story_draft': {
          // AMBIENT WRITE — same as moment_draft above.
          if (subscriberId && sessionId) {
            const anchorId = snapshot.pendingPhoto?.momentId ?? snapshot.activeMomentId ?? null;
            const written = await safe(() =>
              writeAmbientStory({
                subscriberId,
                sessionId,
                draft: result.payload as any,
                turn: snapshot.turn,
                anchorMomentId: anchorId,
              }),
            );
            if (written && snapshot.pendingPhoto) {
              snapshot = clearPhoto(snapshot);
            }
            if (written) {
              await safe(() =>
                appendExchange({
                  sessionId,
                  role: 'system',
                  content: `[river/ambient] story_draft "${(result.payload as any).title}" → pending_review ${written.momentId}`,
                }),
              );
            }
          }
          snapshot = stageDraft(snapshot, result.payload);
          break;
        }
      }
    }

    if (!snapshot.followUpSpent) snapshot = spendFollowUp(snapshot);

    // ── 8. Persist snapshot every turn (E13-08) ───────────────────────────
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
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error('[clm] persistence error (non-fatal):', err);
    return null;
  }
}
