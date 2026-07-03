/**
 * Tests for the Seth prompt scaffold (THOUG-131). Focus: the v0.3 photo-series
 * prompt wiring in buildSethSystemPrompt and the reverence preamble. Run with:
 *   node --import tsx --test packages/shared/src/sethScaffold.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SETH_SCAFFOLD_VERSION,
  buildSethIntroPrompt,
  buildSethSystemPrompt,
  type BuildPromptContext,
} from './sethScaffold.js';
import type { PendingPhoto } from './types.js';

function baseCtx(overrides: Partial<BuildPromptContext> = {}): BuildPromptContext {
  return {
    chapterId: 'world_you_built',
    subscriberName: 'Mara',
    recapPending: false,
    followUpSpent: false,
    closedScopes: [],
    carry: {},
    pendingDraft: null,
    pendingPhoto: null,
    confirmedInChapter: 1,
    ...overrides,
  };
}

const photo = (over: Partial<PendingPhoto> = {}): PendingPhoto => ({
  assetId: 'a1',
  momentId: 'm1',
  ...over,
});

test('scaffold version is v0.4', () => {
  assert.equal(SETH_SCAFFOLD_VERSION, '0.4.0');
});

test('no photo → prompt has no photo-series block', () => {
  const p = buildSethSystemPrompt(baseCtx());
  assert.ok(!p.includes('photo-series beats'));
});

test('pending photo with a description wires every photo-series beat', () => {
  const p = buildSethSystemPrompt(
    baseCtx({ pendingPhoto: photo({ description: 'A faded black-and-white print of two people on a porch.' }) }),
  );
  // Beat 0 validity gate (don't fabricate / non-photo handling).
  assert.match(p, /BEAT 0 — VALIDITY/);
  assert.match(p, /screenshot, a document, a meme/);
  // Beat 1 propose-don't-assert.
  assert.match(p, /Propose, never assert/);
  // Beat 2 mandatory open question.
  assert.match(p, /BEAT 2 — ELICIT ONE DETAIL \(MANDATORY for every photo\)/);
  assert.match(p, /Never a yes\/no, never stacked/);
  // Intra-session identity reuse, still never independently naming.
  assert.match(p, /INTRA-SESSION IDENTITY/);
  assert.match(p, /never extended to anyone they haven't named themselves/);
  assert.match(p, /NEVER name or identify anyone in the picture/);
  // Beat 3 anti-repetition rotation.
  assert.match(p, /never repeat it back-to-back/);
  assert.match(p, /VALIDATE .* SYNTHESIZE .* ACKNOWLEDGE & CLEAR/s);
  // Reverence on in-the-moment decline/silence.
  assert.match(p, /honor it \(Reverence\)/);
});

test('pending photo without a description still asserts validity + invents nothing', () => {
  const p = buildSethSystemPrompt(baseCtx({ pendingPhoto: photo() }));
  assert.match(p, /BEAT 0 — VALIDITY/);
  assert.match(p, /Invent nothing/);
  assert.match(p, /BEAT 2 — ELICIT ONE DETAIL \(MANDATORY for every photo\)/);
});

test('recent file date on a vintage-looking photo is framed as a scan date', () => {
  const p = buildSethSystemPrompt(
    baseCtx({
      pendingPhoto: photo({ description: 'An old, faded print.', whenText: '2026' }),
    }),
  );
  assert.match(p, /DIGITIZED, not when the moment happened/);
  assert.match(p, /do NOT propose it as the memory's date/);
  // Still offered as a question, never a fact, when plausibly genuine.
  assert.match(p, /never as established fact/);
});

test('low vision confidence routes to the graceful non-photo acknowledgment', () => {
  const p = buildSethSystemPrompt(
    baseCtx({ pendingPhoto: photo({ description: 'unclear', visionConfidence: 'low' }) }),
  );
  assert.match(p, /did NOT read as a clear family photograph/);
  assert.match(p, /Did you mean to share a different picture/);
  // It must NOT run the describe/elicit beats on an unreadable image.
  assert.ok(!p.includes('BEAT 2 — ELICIT ONE DETAIL'));
});

test('not-a-family-photo routes to the graceful non-photo acknowledgment', () => {
  const p = buildSethSystemPrompt(
    baseCtx({ pendingPhoto: photo({ description: 'a spreadsheet', isLikelyPhoto: false, visionConfidence: 'high' }) }),
  );
  assert.match(p, /did NOT read as a clear family photograph/);
  assert.ok(!p.includes('BEAT 2 — ELICIT ONE DETAIL'));
});

test('a confident family photo still runs the full beats', () => {
  const p = buildSethSystemPrompt(
    baseCtx({ pendingPhoto: photo({ description: 'two people on a porch', isLikelyPhoto: true, visionConfidence: 'high' }) }),
  );
  assert.match(p, /BEAT 2 — ELICIT ONE DETAIL \(MANDATORY for every photo\)/);
  assert.ok(!p.includes('did NOT read as a clear family photograph'));
});

test('vision skipped/failed (no verdict) falls through to the normal beats', () => {
  const p = buildSethSystemPrompt(baseCtx({ pendingPhoto: photo() }));
  // No isLikelyPhoto/visionConfidence → not treated as a non-photo.
  assert.ok(!p.includes('did NOT read as a clear family photograph'));
  assert.match(p, /BEAT 2 — ELICIT ONE DETAIL/);
});

test('queued photos add the Beat 0b batch acknowledgment', () => {
  const p = buildSethSystemPrompt(
    baseCtx({
      pendingPhoto: photo({ description: 'a porch', isLikelyPhoto: true, visionConfidence: 'high' }),
      queuedPhotoCount: 3,
    }),
  );
  assert.match(p, /BEAT 0b — BATCH/);
  assert.match(p, /3 more are waiting/);
  assert.match(p, /one at a time/);
});

test('no queued photos → no batch note', () => {
  const p = buildSethSystemPrompt(
    baseCtx({ pendingPhoto: photo({ description: 'a porch', isLikelyPhoto: true, visionConfidence: 'high' }) }),
  );
  assert.ok(!p.includes('BEAT 0b — BATCH'));
});

test('operationalReturn injects a gentle re-entry nudge directive', () => {
  const p = buildSethSystemPrompt(baseCtx({ operationalReturn: true }));
  assert.match(p, /resumed after a long pause/);
  assert.match(p, /OPERATIONAL return, NOT a closed door/);
  assert.match(p, /re-entry nudge/);
});

test('no operationalReturn → no re-entry directive', () => {
  const p = buildSethSystemPrompt(baseCtx());
  assert.ok(!p.includes('resumed after a long pause'));
});

test('known named identities are surfaced into the photo identity guidance', () => {
  const p = buildSethSystemPrompt(
    baseCtx({
      pendingPhoto: photo({ description: 'a man by a car', isLikelyPhoto: true, visionConfidence: 'high' }),
      namedIdentities: [
        { name: 'Arthur', firstSeenTurn: 2 },
        { name: 'Mae', firstSeenTurn: 4 },
      ],
    }),
  );
  assert.match(p, /already given you this session/);
  assert.match(p, /Arthur, Mae/);
  assert.match(p, /never a name not on this list/);
});

test('no named identities → no known-names list', () => {
  const p = buildSethSystemPrompt(
    baseCtx({ pendingPhoto: photo({ description: 'a man by a car', isLikelyPhoto: true, visionConfidence: 'high' }) }),
  );
  assert.ok(!p.includes('already given you this session'));
});

test('intro prompt: a held photo makes Seth acknowledge he can see it', () => {
  const p = buildSethIntroPrompt({
    subscriberName: null,
    heldPhotos: [{ storageUrl: 's/x', retainOriginal: false, description: 'two people by a river', isLikelyPhoto: true, visionConfidence: 'high' }],
  });
  assert.match(p, /shared a PHOTOGRAPH and you CAN see it/);
  assert.match(p, /two people by a river/);
  assert.match(p, /do not say you can't see images/);
});

test('intro prompt: an unreadable held image → trouble-seeing, never "can\'t see images"', () => {
  const p = buildSethIntroPrompt({
    subscriberName: null,
    heldPhotos: [{ storageUrl: 's/x', retainOriginal: false, isLikelyPhoto: false, visionConfidence: 'low' }],
  });
  assert.match(p, /having a little trouble seeing this one/);
  assert.match(p, /never claim you simply "can't see images"/);
});

test('intro prompt: no held photo → no photo acknowledgment', () => {
  const p = buildSethIntroPrompt({ subscriberName: null });
  assert.ok(!p.includes('shared a PHOTOGRAPH'));
});

test('walk prompt: a held photo is acknowledged when nothing is pinned yet', () => {
  const p = buildSethSystemPrompt(
    baseCtx({
      confirmedInChapter: 0,
      heldPhoto: { storageUrl: 's/x', retainOriginal: false, description: 'a kitchen', isLikelyPhoto: true, visionConfidence: 'high' },
    }),
  );
  assert.match(p, /shared a PHOTOGRAPH and you CAN see it/);
  assert.match(p, /a kitchen/);
});

test('walk prompt: a pinned photo takes precedence over a held one', () => {
  const p = buildSethSystemPrompt(
    baseCtx({
      pendingPhoto: photo({ description: 'a porch', isLikelyPhoto: true, visionConfidence: 'high' }),
      heldPhoto: { storageUrl: 's/x', retainOriginal: false, description: 'a kitchen' },
    }),
  );
  // Runs the full beats for the pinned photo, not the held acknowledgment.
  assert.match(p, /BEAT 2 — ELICIT ONE DETAIL/);
  assert.ok(!p.includes('shared a PHOTOGRAPH and you CAN see it'));
});

test('reverence preamble distinguishes operational timeout from emotional decline', () => {
  const p = buildSethSystemPrompt(baseCtx());
  assert.match(p, /Operational silence is NOT an emotional decline/);
  assert.match(p, /single gentle, open-ended nudge/);
  assert.match(p, /If that nudge is itself met with silence or a decline, the closed door applies/);
  // P0 strength preserved.
  assert.match(p, /REVERENCE \(P0\)/);
  assert.match(p, /never re-approach that topic, person, or period again/);
});
