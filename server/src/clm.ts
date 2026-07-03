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
  classifyPersonMatch,
  clearDraft,
  clearHeldPhotos,
  clearNameClarification,
  clearPhotoAskAwaiting,
  countPhotoForRecap,
  declinePhotoAsk,
  dequeuePhoto,
  closeScope,
  confirmedInChapter,
  detectClosedDoor,
  detectConfirmation,
  enqueuePhoto,
  extractNamedIdentities,
  hitPhotoSoftCap,
  initialStateSnapshot,
  isOperationalReturn,
  markActivity,
  markPhotoAsked,
  markPhotoBeat,
  nextTurn,
  personSummary,
  photoBeatsComplete,
  photoFocusTurns,
  recordNamedIdentities,
  resetPhotosSinceRecap,
  resolveClarification,
  setActiveMoment,
  setNameClarification,
  spendFollowUp,
  stageDraft,
  suppressPeopleBeat,
  recordConfirmedMoment,
  touchesClosedScope,
  type PersonRecord,
  type ClmMessage,
  type ClmRequestBody,
  type SessionStateSnapshot,
} from '@throughline/shared';
import { generateSethTurn } from './claude.js';
import { appendExchange, getSession, insertMediaAsset, updateSession } from './supabase.js';
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
import {
  commitPendingPhotoPersons,
  discardUnmatchedPhotoPerson,
  fetchPersonRecords,
  getUnmatchedPhotoPersons,
  insertPhotoPerson,
  promoteUnmatchedPhotoPerson,
  resolvePhotoPerson,
  updateMomentPlace,
} from './photoWalk.js';

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

/** Turns a photo may hold focus before the thread is released (stuck-thread valve). */
const PHOTO_FOCUS_TURN_CAP = 14;

/**
 * REVERENCE DEAD-END TRIGGER (P0 ship gate) — deterministic, server-relay only.
 * A name tied to the photo in focus (spoken, or resolved through the family
 * record — including every candidate of an ambiguous match) is checked against
 * the subscriber's closed scopes via exact token match. Model discretion plays
 * no part. Leans toward reverence: ANY candidate touching a closed scope trips
 * the suppression.
 */
function nameHitsClosedScope(
  snapshot: SessionStateSnapshot,
  name: string,
  persons: PersonRecord[],
): boolean {
  if (touchesClosedScope(snapshot, name)) return true;
  const match = classifyPersonMatch(name, persons);
  const candidates = match.personId
    ? persons.filter((p) => p.id === match.personId)
    : match.candidates;
  return candidates.some((p) => {
    if (touchesClosedScope(snapshot, p.full_name)) return true;
    const alts = Array.isArray(p.alt_names) ? p.alt_names : [];
    return alts.some((a) => typeof a === 'string' && touchesClosedScope(snapshot, a));
  });
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
  // Detect an operational return (long inactivity gap) BEFORE stamping this
  // turn's activity — a dropped/backgrounded session is not a closed door (B).
  const operationalReturn = isOperationalReturn(snapshot, Date.now());
  snapshot = nextTurn(snapshot);
  snapshot = markActivity(snapshot, new Date().toISOString());

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
    const introPrompt = buildSethIntroPrompt({
      subscriberName: snapshot.subscriberName,
      heldPhotos: snapshot.heldPhotos,
    });
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
      // Unmatched photo names left unresolved last session roll in here (the
      // unmatched-name lifecycle never leaves rows in silent limbo).
      const priorMoments = await safe(() =>
        getPriorSessionMoments({ subscriberId, currentSessionId: sessionId }),
      ) ?? [];
      const priorUnmatched = (await safe(() => getUnmatchedPhotoPersons(subscriberId))) ?? [];
      if (priorMoments.length > 0 || priorUnmatched.length > 0) {
        const recapText = buildNextSessionRecapPrompt(
          priorMoments,
          priorUnmatched.map((u) => u.displayName),
        );
        sseChunk(res, recapText);
        // The names ask needs a verdict — route the reply through the
        // mid-session recap processor rather than the simple "carry on" path.
        if (priorUnmatched.length > 0) {
          snapshot = { ...snapshot, recapPending: true, nextSessionRecapPending: false };
        }
        await safe(() =>
          appendExchange({
            sessionId,
            role: 'system',
            content: `[recap/next-session] surfaced ${priorMoments.length} prior committed moments + ${priorUnmatched.length} unmatched photo names`,
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
    const unmatched = (await safe(() => getUnmatchedPhotoPersons(subscriberId))) ?? [];

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
      // Unmatched-name lifecycle (HIGH fix): confirm PROMOTES each surfaced
      // name into a stub family record (persons id 'stub_<uuid>') and commits
      // the photo_persons rows — no silent limbo.
      for (const u of unmatched) {
        const promoted = await safe(() => promoteUnmatchedPhotoPerson(u));
        if (promoted) {
          await safe(() =>
            appendExchange({
              sessionId,
              role: 'system',
              content: `[recap/persons] promoted "${u.displayName}" → ${promoted.stubPersonId}`,
            }),
          );
        }
      }
      await safe(() => commitPendingPhotoPersons(subscriberId));
      snapshot = { ...snapshot, recapPending: false };
    } else if (verdict === 'decline') {
      // Drop all pending rows (subscriber rejected the batch).
      for (const row of pendingRows) {
        await safe(() => dropPendingReview(row.momentId));
      }
      // Discard the surfaced unmatched names (status='removed', never deleted).
      for (const u of unmatched) {
        await safe(() => discardUnmatchedPhotoPerson(u.photoPersonId));
      }
      await safe(() =>
        appendExchange({
          sessionId,
          role: 'system',
          content: `[recap] subscriber declined batch — dropped ${pendingRows.length} pending_review rows, discarded ${unmatched.length} unmatched photo names`,
        }),
      );
      snapshot = { ...snapshot, recapPending: false };
    }
    // 'unclear' → leave recapPending=true; Seth re-asks gently via prompt
    // context. Unmatched names left unresolved at session end simply roll into
    // the next session's recap (consistent with the ambient write model).
  }

  // ── 5. Mid-session recap trigger check ───────────────────────────────────
  // Fires at the EARLIEST of chapter boundary, 20-min elapsed, or the ~5-photo
  // soft cap (item B). Does not fire if a recap is already pending.
  if (!snapshot.recapPending && subscriberId && sessionId) {
    const chapterBoundary = snapshot.chapterId !== previousChapterId;
    const timeElapsed = recapTimeElapsed(session?.recapLastAt ?? null);
    const softCap = hitPhotoSoftCap(snapshot);

    if ((chapterBoundary || timeElapsed || softCap) && snapshot.turn > 1) {
      const pendingRows = await safe(() =>
        getPendingReviewRows({ subscriberId, sessionId }),
      ) ?? [];
      const unmatched = (await safe(() => getUnmatchedPhotoPersons(subscriberId))) ?? [];
      const reason = chapterBoundary ? 'chapter boundary' : softCap ? 'photo soft cap' : '20-min elapsed';

      if (pendingRows.length > 0 || unmatched.length > 0) {
        const recapText = buildMidSessionRecapPrompt(
          pendingRows,
          unmatched.map((u) => u.displayName),
        );
        sseChunk(res, recapText);
        snapshot = { ...snapshot, recapPending: true };
        // Reset the photo counter so the soft cap doesn't re-fire every turn.
        snapshot = resetPhotosSinceRecap(snapshot);
        await safe(() => markRecapFired(sessionId));
        await safe(() =>
          appendExchange({
            sessionId,
            role: 'system',
            content: `[recap] ${reason} — surfaced ${pendingRows.length} pending_review rows + ${unmatched.length} unmatched photo names for confirmation`,
          }),
        );
        await safe(() => updateSession(sessionId, { snapshot }));
        sseDone(res);
        return;
      }

      // No pending rows to recap — still reset the timer/counter so the
      // trigger doesn't re-fire on every subsequent turn.
      if (timeElapsed) await safe(() => markRecapFired(sessionId));
      if (softCap) snapshot = resetPhotosSinceRecap(snapshot);
    }
  }

  // Capture any subscriber-supplied names this turn for intra-session reuse (D).
  // Deterministic + high-precision; Seth still never invents an identity.
  const parsedNames = extractNamedIdentities(utterance);
  snapshot = recordNamedIdentities(snapshot, parsedNames, snapshot.turn);

  // The family record, fetched lazily — only when a name needs checking.
  let personsCache: PersonRecord[] | null = null;
  const getPersons = async (): Promise<PersonRecord[]> => {
    if (personsCache) return personsCache;
    personsCache = (await safe(() => fetchPersonRecords())) ?? [];
    return personsCache;
  };

  // ── 5b. REVERENCE DEAD-END TRIGGER (P0) — BEFORE any Beat-3 prompting ─────
  // Deterministic pre-filter on the server relay: names spoken while a photo
  // is in focus are cross-referenced (with their family-record matches, every
  // ambiguous candidate included) against the closed scopes. On a hit, the
  // who's-in-it beat is bypassed entirely for this photo — no acknowledgment,
  // no near-miss phrasing — and Seth pivots to the remaining beats as if it
  // completed. The suppressed name is audit-marked in photo_persons as
  // status='removed' (the store's system-reviewed terminal state; it never
  // surfaces in any recap).
  if (snapshot.pendingPhoto && !snapshot.pendingPhoto.peopleSuppressed && parsedNames.length > 0) {
    const persons = await getPersons();
    for (const name of parsedNames) {
      if (nameHitsClosedScope(snapshot, name, persons)) {
        const assetId = snapshot.pendingPhoto.assetId;
        snapshot = suppressPeopleBeat(snapshot);
        snapshot = clearNameClarification(snapshot);
        if (subscriberId) {
          await safe(() =>
            insertPhotoPerson({
              subscriberId,
              assetId,
              personId: null,
              displayName: name,
              matchConfidence: 'unmatched',
              status: 'removed',
            }),
          );
        }
        if (sessionId) {
          await safe(() =>
            appendExchange({
              sessionId,
              role: 'system',
              content: `[reverence/photo] who's-in-it beat suppressed for asset ${assetId} (closed-scope match)`,
            }),
          );
        }
        break;
      }
    }
  }

  // ── 5c. One-and-done name clarification resolution (D4) ──────────────────
  // Runs only once the question has actually been asked (askedTurn > 0, a
  // prior turn); this utterance is its answer. Resolved or not, the
  // clarification ends here — an unsettled name stays 'ambiguous'.
  if (
    snapshot.pendingNameClarification &&
    snapshot.pendingNameClarification.askedTurn > 0 &&
    snapshot.turn > snapshot.pendingNameClarification.askedTurn
  ) {
    const clarification = snapshot.pendingNameClarification;
    const persons = await getPersons();
    const candidates = persons.filter((p) => clarification.candidateIds.includes(p.id));
    const resolved = resolveClarification(utterance, candidates);
    if (resolved && snapshot.pendingPhoto && nameHitsClosedScope(snapshot, resolved.full_name, persons)) {
      // The clarified person is behind a closed door — dead end, silently.
      snapshot = suppressPeopleBeat(snapshot);
    } else if (resolved && clarification.photoPersonId) {
      await safe(() => resolvePhotoPerson(clarification.photoPersonId!, resolved.id));
      if (sessionId) {
        await safe(() =>
          appendExchange({
            sessionId,
            role: 'system',
            content: `[photo/persons] "${clarification.displayName}" resolved → ${resolved.id}`,
          }),
        );
      }
    }
    snapshot = clearNameClarification(snapshot);
  }

  // ── 5d. Once-per-chapter photo ask lifecycle (AC8) ────────────────────────
  // Armed on chapter entry; consumed here so the ask lands early. If photos
  // are already flowing, the ask's purpose is met — consume it silently.
  const photosInFlight = Boolean(snapshot.pendingPhoto) || snapshot.heldPhotos.length > 0;
  const photoAskDue = snapshot.photoAskPending && !photosInFlight;
  if (snapshot.photoAskPending && photosInFlight) {
    snapshot = { ...markPhotoAsked(snapshot), photoAskAwaitingReply: false };
  }
  const photoAskAwaiting = !photoAskDue && snapshot.photoAskAwaitingReply;

  // ── 6. Claude speaks Seth's turn ──────────────────────────────────────────
  const systemPrompt = buildSethSystemPrompt({
    chapterId: snapshot.chapterId,
    subscriberName: snapshot.subscriberName,
    followUpSpent: snapshot.followUpSpent,
    closedScopes: snapshot.closedScopes,
    carry: snapshot.carry,
    pendingDraft: snapshot.pendingDraft,
    pendingPhoto: snapshot.pendingPhoto,
    heldPhoto: snapshot.heldPhotos[0] ?? null,
    queuedPhotoCount: snapshot.photoQueue.length,
    operationalReturn,
    namedIdentities: snapshot.namedIdentities,
    confirmedInChapter: confirmedInChapter(snapshot),
    recapPending: snapshot.recapPending,
    photoAskPending: photoAskDue,
    photoAskAwaitingReply: photoAskAwaiting,
    // The clarify instruction rides exactly one prompt: the turn it's armed.
    nameClarification:
      snapshot.pendingNameClarification && snapshot.pendingNameClarification.askedTurn === 0
        ? snapshot.pendingNameClarification
        : null,
  });
  // The ask is in this turn's prompt — never again this chapter; the next
  // reply is read for a decline (one-shot).
  if (photoAskDue) snapshot = markPhotoAsked(snapshot);
  else if (photoAskAwaiting) snapshot = clearPhotoAskAwaiting(snapshot);
  // The clarifying question goes out this turn — stamp it so the NEXT reply
  // is read as its answer (5c) and it is never asked twice.
  if (snapshot.pendingNameClarification && snapshot.pendingNameClarification.askedTurn === 0) {
    snapshot = setNameClarification(snapshot, {
      ...snapshot.pendingNameClarification,
      askedTurn: snapshot.turn,
    });
  }

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

              // Materialize any photos HELD before this first Moment existed
              // (e.g. shared during the Introduction): now we have a moment_id,
              // write their media_assets rows and pin/queue them so the photo
              // beats run. The bytes + vision review were captured at upload.
              if (snapshot.heldPhotos.length > 0) {
                let materialized = 0;
                for (const held of snapshot.heldPhotos) {
                  const asset = await safe(() =>
                    insertMediaAsset({
                      momentId: written.momentId,
                      storageUrl: held.storageUrl,
                      retainOriginal: held.retainOriginal,
                    }),
                  );
                  if (!asset) continue;
                  snapshot = enqueuePhoto(snapshot, {
                    assetId: asset.assetId,
                    momentId: written.momentId,
                    whenText: held.whenText,
                    whereText: held.whereText,
                    description: held.description,
                    isLikelyPhoto: held.isLikelyPhoto,
                    visionConfidence: held.visionConfidence,
                  });
                  snapshot = countPhotoForRecap(snapshot);
                  materialized++;
                }
                snapshot = clearHeldPhotos(snapshot);
                await safe(() =>
                  appendExchange({
                    sessionId,
                    role: 'system',
                    content: `[photos] materialized ${materialized} held photo(s) onto moment ${written.momentId}`,
                  }),
                );
              }

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
          // AMBIENT WRITE — same as moment_draft above. A story told over the
          // photo in focus covers the MEMORIES beat (AC10) and is tagged
          // ['photo_walk'] so the session-close orphan check can find it; the
          // photo itself stays in focus until all three beats are touched.
          if (subscriberId && sessionId) {
            const wasPhotoStory = Boolean(snapshot.pendingPhoto);
            const anchorId = snapshot.pendingPhoto?.momentId ?? snapshot.activeMomentId ?? null;
            const written = await safe(() =>
              writeAmbientStory({
                subscriberId,
                sessionId,
                draft: result.payload as any,
                turn: snapshot.turn,
                anchorMomentId: anchorId,
                clusterTags: wasPhotoStory ? ['photo_walk'] : [],
              }),
            );
            if (written && wasPhotoStory) {
              snapshot = markPhotoBeat(snapshot, 'memories');
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
        case 'photo_ask_outcome': {
          // AC8/D5 — chapter-scoped suppression only; never a Reverence closure.
          snapshot = declinePhotoAsk(snapshot);
          if (sessionId) {
            await safe(() =>
              appendExchange({
                sessionId,
                role: 'system',
                content: `[photo/ask] declined for chapter ${snapshot.chapterId} — suppressed for this chapter (not a closed topic)`,
              }),
            );
          }
          break;
        }
        case 'photo_details': {
          const details = result.payload;
          const photo = snapshot.pendingPhoto;
          if (!photo) break;

          // Time & place beat — free-text place onto the anchor Moment (D2).
          if (details.whenText || details.placeText) {
            snapshot = markPhotoBeat(snapshot, 'timePlace');
            if (details.placeText) {
              await safe(() => updateMomentPlace(photo.momentId, details.placeText!));
            }
          }

          // Who's-in-it beat — match against the family record (AC11), with
          // the Dead-End Trigger re-checked on every name (P0).
          if (details.noPeople) {
            snapshot = markPhotoBeat(snapshot, 'people');
          }
          if (details.personNames && !snapshot.pendingPhoto?.peopleSuppressed) {
            const persons = await getPersons();
            for (const spoken of details.personNames) {
              if (nameHitsClosedScope(snapshot, spoken, persons)) {
                snapshot = suppressPeopleBeat(snapshot);
                snapshot = clearNameClarification(snapshot);
                if (subscriberId) {
                  await safe(() =>
                    insertPhotoPerson({
                      subscriberId,
                      assetId: photo.assetId,
                      personId: null,
                      displayName: spoken,
                      matchConfidence: 'unmatched',
                      status: 'removed',
                    }),
                  );
                }
                if (sessionId) {
                  await safe(() =>
                    appendExchange({
                      sessionId,
                      role: 'system',
                      content: `[reverence/photo] who's-in-it beat suppressed for asset ${photo.assetId} (closed-scope match)`,
                    }),
                  );
                }
                break;
              }
              const match = classifyPersonMatch(spoken, persons);
              if (subscriberId) {
                const row = await safe(() =>
                  insertPhotoPerson({
                    subscriberId,
                    assetId: photo.assetId,
                    personId: match.personId,
                    displayName: spoken,
                    matchConfidence: match.confidence,
                  }),
                );
                // D4 — arm the ONE clarifying question for the first ambiguous
                // name (one clarification in flight at a time; the rest stay
                // 'ambiguous' rather than queueing an interrogation).
                if (
                  row &&
                  match.confidence === 'ambiguous' &&
                  !snapshot.pendingNameClarification
                ) {
                  snapshot = setNameClarification(snapshot, {
                    displayName: spoken,
                    photoPersonId: row.photoPersonId,
                    candidateIds: match.candidates.map((c) => c.id),
                    candidateSummaries: match.candidates.slice(0, 3).map(personSummary),
                    askedTurn: 0,
                  });
                }
                if (sessionId) {
                  await safe(() =>
                    appendExchange({
                      sessionId,
                      role: 'system',
                      content: `[photo/persons] "${spoken}" → ${match.confidence}${match.personId ? ` (${match.personId})` : ''} on asset ${photo.assetId}`,
                    }),
                  );
                }
              }
              snapshot = markPhotoBeat(snapshot, 'people');
            }
          }

          // The model attests all beats were touched — release the photo.
          if (details.threadComplete) {
            snapshot = markPhotoBeat(snapshot, 'memories');
            snapshot = markPhotoBeat(snapshot, 'timePlace');
            snapshot = markPhotoBeat(snapshot, 'people');
          }
          break;
        }
      }
    }

    // ── 7b. Photo thread closure (AC10) ────────────────────────────────────
    // The photo releases when all three beats are touched (a suppressed
    // people beat counts), or after the safety-valve turn cap so a thread can
    // never wedge the session. Dequeue brings the next batch photo into focus.
    if (snapshot.pendingPhoto) {
      const stuck = photoFocusTurns(snapshot) > PHOTO_FOCUS_TURN_CAP;
      if (photoBeatsComplete(snapshot) || stuck) {
        if (stuck && sessionId) {
          await safe(() =>
            appendExchange({
              sessionId,
              role: 'system',
              content: `[photo] focus released by turn cap for asset ${snapshot.pendingPhoto!.assetId} (beats incomplete)`,
            }),
          );
        }
        snapshot = dequeuePhoto(snapshot);
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
