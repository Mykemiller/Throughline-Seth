/**
 * Photo ingest (E13-05/06, THOUG-132) — server side of the three-tier model.
 *
 * The BROWSER does the EXIF work (parse date/place, strip metadata via canvas
 * re-encode) so raw EXIF never crosses the wire — privacy + injection safety.
 * This route receives:
 *   - strippedBase64: the metadata-free JPEG derivative (required)
 *   - originalBase64: untouched bytes, ONLY when retainOriginal=true (opt-in)
 *   - whenText/whereText: validated text metadata parsed client-side
 *
 * It uploads to Supabase Storage, pins a media_assets row to the session's
 * active Moment, and marks the photo pending in the snapshot so Seth elicits
 * spoken commentary on the next turn (→ Layer 3 Story via the confirm path).
 */
import type { Request, Response } from 'express';
import { clearDraft, pinPhoto } from '@throughline/shared';
import { describePhotograph } from './claude.js';
import { getSession, updateSession, uploadAndPinPhoto } from './supabase.js';

export async function handlePhotoUpload(req: Request, res: Response): Promise<void> {
  const { sessionId, strippedBase64, originalBase64, retainOriginal, whenText, whereText } =
    req.body ?? {};
  if (typeof sessionId !== 'string' || typeof strippedBase64 !== 'string') {
    res.status(400).json({ error: 'sessionId and strippedBase64 are required' });
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  if (!session.snapshot.activeMomentId) {
    res.status(409).json({
      error:
        'no active Moment to pin to yet — confirm a Moment with Seth first, then add the photograph',
    });
    return;
  }

  try {
    const stripped = Buffer.from(strippedBase64, 'base64');
    const original =
      retainOriginal === true && typeof originalBase64 === 'string'
        ? Buffer.from(originalBase64, 'base64')
        : null;
    const { assetId } = await uploadAndPinPhoto({
      momentId: session.snapshot.activeMomentId,
      strippedJpeg: stripped,
      original,
      retainOriginal: retainOriginal === true,
    });

    // Vision "review" of the clean derivative — grounded, best-effort, so Seth
    // can gently reference what he can see and gate Beat 0a on a non-photo /
    // low-confidence read. A failure here must never block the pin, so
    // describePhotograph swallows its own errors and returns undefined.
    const review = await describePhotograph({ strippedJpegBase64: strippedBase64 });

    // Pin in the snapshot → Seth invites commentary next turn. Any stale
    // pending draft is cleared so the story confirmation can't cross wires.
    let snapshot = clearDraft(session.snapshot);
    snapshot = pinPhoto(snapshot, {
      assetId,
      momentId: session.snapshot.activeMomentId,
      whenText: typeof whenText === 'string' && whenText ? whenText : undefined,
      whereText: typeof whereText === 'string' && whereText ? whereText : undefined,
      description: review?.description,
      isLikelyPhoto: review?.isLikelyFamilyPhotograph,
      visionConfidence: review?.confidence,
    });
    await updateSession(sessionId, { snapshot });

    res.json({ assetId, momentId: session.snapshot.activeMomentId });
  } catch (err) {
    console.error('[photos]', err);
    res.status(500).json({ error: 'photo upload failed' });
  }
}
