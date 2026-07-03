/**
 * First Thread voice runtime — server entry.
 *
 * Hosts the Hume BYO-LLM custom-language-model endpoint (where Claude sits), the
 * Hume access-token minter, and the session/transcript persistence routes. The
 * entire surface is gated behind the `first_thread_voice` feature flag and is
 * dormant (404) when the flag is off.
 */
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ChapterId, ExchangeRole } from '@throughline/shared';
import { CHAPTER_ORDER, jumpToChapter } from '@throughline/shared';
import { FIRST_THREAD_VOICE, PORT, requireSecrets } from './env.js';
import { handleClmRequest } from './clm.js';
import { mintHumeAccessToken } from './humeToken.js';
import {
  appendExchange,
  createSession,
  findResumableSession,
  getSession,
  listSessionPhotos,
  updateSession,
} from './supabase.js';
import { handlePhotoUpload } from './photos.js';
import { findOrphanedPhotoStories } from './photoWalk.js';

export const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // photo uploads ride JSON base64 in the prototype

// Health check is always available (useful for "is the flag on?" diagnostics).
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, firstThreadVoice: FIRST_THREAD_VOICE });
});

/** Gate: the voice runtime is off unless `first_thread_voice` is enabled. */
function requireFlag(_req: Request, res: Response, next: NextFunction): void {
  if (!FIRST_THREAD_VOICE) {
    res.status(404).json({ error: 'first_thread_voice is disabled' });
    return;
  }
  next();
}

// Mint a short-lived Hume access token (+ the ZDR/BYO-LLM config id).
app.get('/api/hume/token', requireFlag, async (_req, res) => {
  try {
    res.json(await mintHumeAccessToken());
  } catch (err) {
    console.error('[hume/token]', err);
    res.status(500).json({ error: 'failed to mint Hume access token' });
  }
});

// Create a First Thread voice session (rot_capture_sessions row).
app.post('/api/sessions', requireFlag, async (_req, res) => {
  try {
    const { sessionId, snapshot } = await createSession();
    res.json({ sessionId, snapshot });
  } catch (err) {
    console.error('[sessions:create]', err);
    res.status(500).json({ error: 'failed to create session' });
  }
});

// Update session status (snapshot updates flow through the CLM endpoint).
app.patch('/api/sessions/:id', requireFlag, async (req, res) => {
  const id = req.params.id;
  const status = req.body?.status;
  if (!id) {
    res.status(400).json({ error: 'session id required' });
    return;
  }
  if (status && !['in_progress', 'complete', 'abandoned'].includes(status)) {
    res.status(400).json({ error: 'invalid status' });
    return;
  }
  try {
    await updateSession(id, { status });
    // Session-close orphan check (THOUG-132, lightweight — no cron): any
    // pending_review photo-anchored story whose asset is gone gets flagged for
    // review via a system exchange, so the next recap surfaces it. Never
    // hard-deleted. Best-effort — a failure here never blocks the close.
    if (status === 'complete') {
      try {
        const session = await getSession(id);
        if (session) {
          const orphans = await findOrphanedPhotoStories(session.subscriberId);
          for (const o of orphans) {
            await appendExchange({
              sessionId: id,
              role: 'system',
              content: `[cleanup] photo story "${o.title}" (${o.momentId}) has no surviving asset on its anchor — flagged for review at next recap`,
            });
          }
          if (orphans.length > 0) {
            console.log('[sessions:close] flagged orphaned photo stories', orphans.length);
          }
        }
      } catch (err) {
        console.error('[sessions:close] orphan check failed (non-fatal):', err);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[sessions:update]', err);
    res.status(500).json({ error: 'failed to update session' });
  }
});

// Append an uttered exchange. The browser calls this with the ACTUAL transcript
// from Hume (subscriber + companion), including the barge-in `interrupted` flag.
app.post('/api/exchanges', requireFlag, async (req, res) => {
  const { sessionId, role, content, interrupted } = req.body ?? {};
  const validRoles: ExchangeRole[] = ['companion', 'subscriber', 'system'];
  if (typeof sessionId !== 'string' || !validRoles.includes(role) || typeof content !== 'string') {
    res.status(400).json({ error: 'sessionId, role (companion|subscriber|system) and content are required' });
    return;
  }
  try {
    const row = await appendExchange({ sessionId, role, content, interrupted: Boolean(interrupted) });
    res.json({ id: row.id, created_at: row.created_at });
  } catch (err) {
    console.error('[exchanges:append]', err);
    res.status(500).json({ error: 'failed to append exchange' });
  }
});

// Resume: most recent in_progress session for the owner (E13-08).
app.get('/api/sessions/resumable', requireFlag, async (_req, res) => {
  try {
    res.json((await findResumableSession()) ?? {});
  } catch (err) {
    console.error('[sessions:resumable]', err);
    res.status(500).json({ error: 'failed to look up resumable session' });
  }
});

// Live flow state for the UI (chapter, pending draft/photo, active Moment).
app.get('/api/sessions/:id/state', requireFlag, async (req, res) => {
  try {
    const session = await getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json({ snapshot: session.snapshot });
  } catch (err) {
    console.error('[sessions:state]', err);
    res.status(500).json({ error: 'failed to load session state' });
  }
});

// Subscriber-initiated chapter navigation (the visible chapter rail). This
// deliberately allows jumping to any chapter, in any direction (owner override
// 2026-06-14) — reverence closures are always preserved by jumpToChapter.
app.post('/api/sessions/:id/chapter', requireFlag, async (req, res) => {
  const id = req.params.id;
  const chapterId = req.body?.chapterId as ChapterId | undefined;
  if (!id) {
    res.status(400).json({ error: 'session id required' });
    return;
  }
  if (!chapterId || !CHAPTER_ORDER.includes(chapterId)) {
    res.status(400).json({ error: 'valid chapterId required' });
    return;
  }
  try {
    const session = await getSession(id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const snapshot = jumpToChapter(session.snapshot, chapterId);
    await updateSession(id, { snapshot });
    res.json({ snapshot });
  } catch (err) {
    console.error('[sessions:chapter]', err);
    res.status(500).json({ error: 'failed to set chapter' });
  }
});

// Photo upload: EXIF-stripped bytes from the browser → Storage → media_assets
// pinned to the active Moment (E13-05/06, THOUG-132).
app.post('/api/photos', requireFlag, handlePhotoUpload);

// Photos shared during a session, signed for inline display in the
// conversation card (AC9, THOUG-132 Photo Walk).
app.get('/api/sessions/:id/photos', requireFlag, async (req, res) => {
  try {
    res.json({ photos: await listSessionPhotos(req.params.id!) });
  } catch (err) {
    console.error('[sessions:photos]', err);
    res.status(500).json({ error: 'failed to list session photos' });
  }
});

// The Hume EVI 3 BYO-LLM endpoint. Hume's config points its custom language
// model at this path; it streams OpenAI-compatible chat-completion chunks.
app.post('/api/clm/chat/completions', requireFlag, handleClmRequest);

function start(): void {
  if (process.env.VERCEL) return; // serverless: Vercel invokes the exported app
  if (FIRST_THREAD_VOICE) {
    // Fail fast and loud if a required secret is missing — never improvise.
    try {
      requireSecrets();
    } catch (err) {
      console.error(`\n[first_thread_voice] cannot start:\n  ${(err as Error).message}\n`);
      process.exit(1);
    }
  }
  app.listen(PORT, () => {
    console.log(
      `[throughline server] listening on :${PORT} — first_thread_voice ${FIRST_THREAD_VOICE ? 'ON' : 'OFF (routes 404)'}`,
    );
  });
}

start();
