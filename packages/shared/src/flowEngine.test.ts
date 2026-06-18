/**
 * Tests for the seven-chapter flow engine (THOUG-131). Run with:
 *   node --import tsx --test packages/shared/src/flowEngine.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceChapter,
  applyChapterComplete,
  applyIntroComplete,
  canAdvance,
  closeScope,
  confirmedInChapter,
  detectConfirmation,
  isFinalChapter,
  isIntro,
  jumpToChapter,
  recordConfirmedMoment,
  reviveSnapshot,
  setActiveMoment,
  silenceToleranceMs,
  stageDraft,
  touchesClosedScope,
} from './flowEngine.js';
import { CHAPTER_ORDER, getChapter, initialStateSnapshot } from './sethScaffold.js';
import type { SessionStateSnapshot } from './types.js';

test('the chapter spine is the locked v0.2 order', () => {
  assert.deepEqual(CHAPTER_ORDER, [
    'first_light',
    'school_years',
    'becoming',
    'world_you_built',
    'what_stayed',
    'still_becoming',
    'last_night',
  ]);
  for (const id of CHAPTER_ORDER) {
    const ch = getChapter(id);
    assert.ok(ch.openingPrompt.length > 20, `${id} has a real opening prompt`);
    assert.ok(ch.silenceToleranceMs >= 6000, `${id} honors long pauses`);
  }
});

test('a chapter never advances without a confirmed Moment (never forced)', () => {
  const snap = initialStateSnapshot();
  assert.equal(canAdvance(snap), false);
  assert.equal(advanceChapter(snap).chapterId, 'first_light'); // refused
});

test('advance is one step forward and resets the follow-up budget', () => {
  let snap = initialStateSnapshot();
  snap = { ...snap, followUpSpent: true };
  snap = recordConfirmedMoment(snap, 'moment-1');
  const next = advanceChapter(snap);
  assert.equal(next.chapterId, 'school_years');
  assert.equal(next.followUpSpent, false);
});

test('chapter_complete from the model is rejected for the wrong chapter', () => {
  let snap = initialStateSnapshot();
  snap = recordConfirmedMoment(snap, 'moment-1');
  const wrong = applyChapterComplete(snap, { kind: 'chapter_complete', chapterId: 'becoming' });
  assert.equal(wrong.chapterId, 'first_light');
  const right = applyChapterComplete(snap, {
    kind: 'chapter_complete',
    chapterId: 'first_light',
    carryDetail: 'the smell of her kitchen',
  });
  assert.equal(right.chapterId, 'school_years');
  assert.equal(right.carry['from_first_light'], 'the smell of her kitchen');
});

test('final chapter never advances past Last Night', () => {
  let snap: SessionStateSnapshot = { ...initialStateSnapshot(), chapterId: 'last_night' };
  snap = recordConfirmedMoment(snap, 'moment-x');
  assert.ok(isFinalChapter(snap));
  assert.equal(advanceChapter(snap).chapterId, 'last_night');
});

test('dynamic pacing scales with chapter weight', () => {
  const light = { ...initialStateSnapshot(), chapterId: 'last_night' as const };
  const heavy = { ...initialStateSnapshot(), chapterId: 'world_you_built' as const };
  assert.ok(silenceToleranceMs(heavy) > silenceToleranceMs(light));
});

test('confirmation detector: decline wins, unclear never commits', () => {
  assert.equal(detectConfirmation('Yes, that feels right.'), 'confirm');
  assert.equal(detectConfirmation("No, that's not right at all."), 'decline');
  assert.equal(detectConfirmation('Hmm, well, my sister was there too.'), 'unclear');
  // Both present → decline wins (never commit on a maybe).
  assert.equal(detectConfirmation('Yes... actually no, not quite.'), 'decline');
});

test('staged drafts await confirmation and carry the staging turn', () => {
  let snap = { ...initialStateSnapshot(), turn: 7 };
  snap = stageDraft(snap, {
    kind: 'moment_draft',
    title: 'The lake house',
    summary: 'Summers at the lake house with her grandfather.',
    chapterId: 'first_light',
  });
  assert.equal(snap.pendingDraft?.stagedAtTurn, 7);
});

test('reviveSnapshot upgrades a legacy v1 snapshot without losing closures', () => {
  const legacy = {
    chapterId: 'roots', // v1 chapter id that no longer exists
    followUpSpent: true,
    closedScopes: [{ phrase: 'stop talking about the divorce', closedAt: 'x', chapterId: 'roots' }],
    carry: { name: 'Eleanor' },
    v: 1,
  };
  const revived = reviveSnapshot(legacy);
  assert.equal(revived.v, 5);
  assert.equal(revived.chapterId, 'first_light'); // unknown chapter → safe start
  assert.equal(revived.phase, 'walk'); // legacy session never replays the intro
  assert.equal(revived.closedScopes.length, 1);
  assert.ok(revived.closedScopes[0]!.matchTokens.includes('divorce'));
  assert.equal(revived.carry.name, 'Eleanor');
  // v5 photo-series fields default safely when absent from an older snapshot.
  assert.deepEqual(revived.photoQueue, []);
  assert.equal(revived.photosSinceRecap, 0);
  assert.equal(revived.lastActivityAt, null);
  assert.deepEqual(revived.namedIdentities, []);
});

test('setActiveMoment sets the pin target without counting chapter completeness', () => {
  const snap = initialStateSnapshot();
  assert.equal(snap.activeMomentId, null);
  assert.equal(canAdvance(snap), false);

  const pinned = setActiveMoment(snap, 'm-ambient-1');
  assert.equal(pinned.activeMomentId, 'm-ambient-1'); // photo can pin now
  assert.equal(confirmedInChapter(pinned), 0); // but the chapter is NOT complete
  assert.equal(canAdvance(pinned), false); // completeness still needs recap confirm

  // Idempotent on the same id.
  assert.equal(setActiveMoment(pinned, 'm-ambient-1'), pinned);

  // recordConfirmedMoment is what actually advances completeness.
  const confirmed = recordConfirmedMoment(pinned, 'm-ambient-1');
  assert.equal(confirmed.activeMomentId, 'm-ambient-1');
  assert.equal(confirmedInChapter(confirmed), 1);
});

test('reviveSnapshot preserves v5 photo-series fields on round-trip', () => {
  const v5 = {
    ...initialStateSnapshot(),
    photosSinceRecap: 3,
    lastActivityAt: '2026-06-18T17:00:00.000Z',
    namedIdentities: [{ name: 'Arthur', firstSeenTurn: 4 }],
  };
  const revived = reviveSnapshot(v5);
  assert.equal(revived.photosSinceRecap, 3);
  assert.equal(revived.lastActivityAt, '2026-06-18T17:00:00.000Z');
  assert.deepEqual(revived.namedIdentities, [{ name: 'Arthur', firstSeenTurn: 4 }]);
});

test('pre-prompt gate: closed scopes match on tokens, not fuzz', () => {
  let snap = initialStateSnapshot();
  snap = closeScope(snap, 'stop talking about the divorce');
  assert.ok(touchesClosedScope(snap, 'Tell me about the divorce settlement'));
  assert.ok(touchesClosedScope(snap, 'what happened with the divorces'), 'plural folds');
  assert.equal(touchesClosedScope(snap, 'Tell me about your wedding day'), null);
});


test('new sessions begin in the intro phase with no name', () => {
  const snap = initialStateSnapshot();
  assert.equal(snap.phase, 'intro');
  assert.equal(isIntro(snap), true);
  assert.equal(snap.subscriberName, null);
  assert.equal(snap.chapterId, 'first_light');
});

test('applyIntroComplete records the name and enters the walk at First Light', () => {
  const snap = initialStateSnapshot();
  const next = applyIntroComplete(snap, { kind: 'intro_complete', name: '  Eleanor  ' });
  assert.equal(next.phase, 'walk');
  assert.equal(isIntro(next), false);
  assert.equal(next.subscriberName, 'Eleanor'); // trimmed
  assert.equal(next.chapterId, 'first_light');
});

test('jumpToChapter moves to any chapter, ends the intro, and preserves closures', () => {
  let snap = initialStateSnapshot();
  snap = closeScope(snap, 'stop talking about the divorce');
  snap = recordConfirmedMoment(snap, 'moment-1'); // confirm a Moment in first_light
  const before = snap.confirmedMoments.first_light;

  const jumped = jumpToChapter(snap, 'what_stayed');
  assert.equal(jumped.phase, 'walk');
  assert.equal(jumped.chapterId, 'what_stayed');
  assert.equal(jumped.followUpSpent, false);
  // Reverence + prior progress are untouched by a jump.
  assert.equal(jumped.closedScopes.length, 1);
  assert.equal(jumped.confirmedMoments.first_light, before);
});

test('jumpToChapter rejects an unknown chapter and is a no-op on the current one', () => {
  const walk = jumpToChapter(initialStateSnapshot(), 'first_light'); // from intro → enters walk
  assert.equal(walk.phase, 'walk');
  // @ts-expect-error invalid chapter id is rejected at runtime
  assert.equal(jumpToChapter(walk, 'not_a_chapter').chapterId, 'first_light');
  assert.equal(jumpToChapter(walk, 'first_light'), walk); // same chapter in walk → unchanged ref
});
