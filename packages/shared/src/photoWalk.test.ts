/**
 * Tests for the Photo Walk engine pieces (THOUG-132 v0.3): the once-per-chapter
 * photo ask (AC8/D5), three-beat tracking (AC10), the suppressed people beat
 * (Reverence Dead-End Trigger, P0), name matching (AC11/D4), and the v2
 * snapshot read shim (THOUG-129 closing item). Run with:
 *   node --import tsx --test packages/shared/src/photoWalk.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceChapter,
  applyIntroComplete,
  armPhotoAsk,
  clearNameClarification,
  clearPhotoAskAwaiting,
  declinePhotoAsk,
  dequeuePhoto,
  enqueuePhoto,
  jumpToChapter,
  markPhotoAsked,
  markPhotoBeat,
  photoBeatsComplete,
  photoFocusTurns,
  recordConfirmedMoment,
  reviveSnapshot,
  setNameClarification,
  suppressPeopleBeat,
  touchesClosedScope,
  closeScope,
} from './flowEngine.js';
import {
  classifyPersonMatch,
  personSummary,
  resolveClarification,
  type PersonRecord,
} from './personMatch.js';
import { initialStateSnapshot } from './sethScaffold.js';
import type { SessionStateSnapshot } from './types.js';

function walking(): SessionStateSnapshot {
  return { ...initialStateSnapshot(), phase: 'walk', turn: 3 };
}

/* ── AC8/D5 — the once-per-chapter photo ask ──────────────────────────────── */

test('intro completion arms the first chapter photo ask', () => {
  const s = applyIntroComplete(initialStateSnapshot(), { kind: 'intro_complete', name: 'Myke' });
  assert.equal(s.photoAskPending, true);
});

test('chapter advance arms the ask for the new chapter', () => {
  let s = recordConfirmedMoment(walking(), 'm-1');
  s = markPhotoAsked(s); // first_light already asked
  s = advanceChapter(s);
  assert.equal(s.chapterId, 'school_years');
  assert.equal(s.photoAskPending, true);
});

test('the ask is once per chapter — never re-armed after being made', () => {
  let s = markPhotoAsked(walking());
  assert.equal(s.photoAskAwaitingReply, true);
  assert.ok(s.photoAskedChapters.includes('first_light'));
  s = armPhotoAsk(s);
  assert.equal(s.photoAskPending, false);
});

test('a declined chapter stays declined and is not a Reverence closure', () => {
  let s = declinePhotoAsk(walking());
  assert.ok(s.photoDeclinedChapters.includes('first_light'));
  assert.equal(s.closedScopes.length, 0); // D5: chapter-scoped suppression only
  s = armPhotoAsk(s);
  assert.equal(s.photoAskPending, false);
  // …but a different chapter still gets its ask.
  s = jumpToChapter(s, 'becoming');
  assert.equal(s.photoAskPending, true);
});

test('the awaiting-reply flag is one-shot', () => {
  let s = markPhotoAsked(walking());
  s = clearPhotoAskAwaiting(s);
  assert.equal(s.photoAskAwaitingReply, false);
});

/* ── AC10 — three-beat coverage on the photo in focus ─────────────────────── */

function withPhoto(): SessionStateSnapshot {
  return enqueuePhoto(walking(), { assetId: 'a-1', momentId: 'm-1' });
}

test('a fresh pin starts with no beats covered and stamps focus turn', () => {
  const s = withPhoto();
  assert.deepEqual(s.pendingPhoto?.beats, { memories: false, timePlace: false, people: false });
  assert.equal(s.pendingPhoto?.focusedAtTurn, 3);
  assert.equal(photoBeatsComplete(s), false);
});

test('the thread closes only when all three beats are touched', () => {
  let s = withPhoto();
  s = markPhotoBeat(s, 'memories');
  s = markPhotoBeat(s, 'timePlace');
  assert.equal(photoBeatsComplete(s), false);
  s = markPhotoBeat(s, 'people');
  assert.equal(photoBeatsComplete(s), true);
});

test('dequeue restamps focus turn for the next queued photo', () => {
  let s = withPhoto();
  s = enqueuePhoto(s, { assetId: 'a-2', momentId: 'm-1' });
  s = { ...s, turn: 9 };
  s = dequeuePhoto(s);
  assert.equal(s.pendingPhoto?.assetId, 'a-2');
  assert.equal(s.pendingPhoto?.focusedAtTurn, 9);
  assert.equal(photoFocusTurns(s), 0);
});

/* ── P0 — the suppressed people beat (Dead-End Trigger surface) ───────────── */

test('suppression covers the people beat, flags the photo, and closes with the rest', () => {
  let s = withPhoto();
  s = suppressPeopleBeat(s);
  assert.equal(s.pendingPhoto?.peopleSuppressed, true);
  assert.equal(s.pendingPhoto?.beats?.people, true);
  s = markPhotoBeat(s, 'memories');
  s = markPhotoBeat(s, 'timePlace');
  assert.equal(photoBeatsComplete(s), true);
});

test('a closed scope still token-matches a person name (the trigger primitive)', () => {
  let s = withPhoto();
  s = closeScope(s, 'my sister Ruth');
  assert.ok(touchesClosedScope(s, 'Ruth'));
  assert.ok(touchesClosedScope(s, 'Ruth Morgan'));
  assert.equal(touchesClosedScope(s, 'Arthur'), null);
});

/* ── AC11/D4 — name matching + one-and-done clarification ─────────────────── */

const FAMILY: PersonRecord[] = [
  { id: 'p1', full_name: 'Ruth Morgan', given_name: 'Ruth', surname: 'Morgan', birth_year: 1902, alt_names: [] },
  { id: 'p2', full_name: 'Ruth Ann Bull', given_name: 'Ruth Ann', surname: 'Bull', birth_year: 1934, alt_names: ['Ruthie'] },
  { id: 'p3', full_name: 'Arthur Miller', given_name: 'Arthur', surname: 'Miller', birth_year: 1928, alt_names: [] },
  { id: 'p4', full_name: 'Warren Eber Morgan', given_name: 'Warren Eber', surname: 'Morgan', birth_year: 1911, alt_names: [] },
];

test('exact: full_name and given+surname resolve to one person', () => {
  assert.equal(classifyPersonMatch('Arthur Miller', FAMILY).confidence, 'exact');
  assert.equal(classifyPersonMatch('arthur miller', FAMILY).personId, 'p3');
  assert.equal(classifyPersonMatch('Ruth Morgan', FAMILY).confidence, 'exact');
});

test('fuzzy: a single given-name or alt_names hit', () => {
  const arthur = classifyPersonMatch('Arthur', FAMILY);
  assert.equal(arthur.confidence, 'fuzzy');
  assert.equal(arthur.personId, 'p3');
  const warren = classifyPersonMatch('Warren', FAMILY);
  assert.equal(warren.confidence, 'fuzzy');
  assert.equal(warren.personId, 'p4');
});

test('ambiguous: two Ruths stay unresolved with both candidates carried', () => {
  const m = classifyPersonMatch('Ruth', FAMILY);
  assert.equal(m.confidence, 'ambiguous');
  assert.equal(m.personId, null);
  assert.deepEqual(m.candidates.map((c) => c.id).sort(), ['p1', 'p2']);
});

test('unmatched: a name with no plausible record', () => {
  assert.equal(classifyPersonMatch('Zebediah', FAMILY).confidence, 'unmatched');
});

test('clarification resolves on a birth year, a distinguishing token, or older/younger', () => {
  const candidates = [FAMILY[0]!, FAMILY[1]!];
  assert.equal(resolveClarification('she was born in 1934 I think', candidates)?.id, 'p2');
  assert.equal(resolveClarification('the one who married a Bull', candidates)?.id, 'p2');
  assert.equal(resolveClarification('the older one', candidates)?.id, 'p1');
  assert.equal(resolveClarification("honestly I'm not sure", candidates), null);
});

test('personSummary is spoken-safe', () => {
  assert.equal(personSummary(FAMILY[0]!), 'Ruth Morgan, born 1902');
});

test('clarification state is one-and-done', () => {
  let s = setNameClarification(walking(), {
    displayName: 'Ruth',
    photoPersonId: 'pp-1',
    candidateIds: ['p1', 'p2'],
    candidateSummaries: ['Ruth Morgan, born 1902', 'Ruth Ann Bull, born 1934'],
    askedTurn: 0,
  });
  assert.equal(s.pendingNameClarification?.displayName, 'Ruth');
  s = clearNameClarification(s);
  assert.equal(s.pendingNameClarification, null);
});

/* ── THOUG-129 — the v2 snapshot read shim ─────────────────────────────────── */

test('a live-shape v2 snapshot revives to v6 with safe defaults', () => {
  // Exact key set of the four legacy rows verified live 2026-07-03.
  const v2 = {
    v: 2,
    turn: 7,
    carry: { from_first_light: 'the kitchen' },
    chapterId: 'school_years',
    closedScopes: [],
    followUpSpent: true,
    pendingDraft: null,
    pendingPhoto: null,
    activeMomentId: null,
    confirmedMoments: { first_light: 1 },
  };
  const s = reviveSnapshot(v2);
  assert.equal(s.v, 6);
  assert.equal(s.chapterId, 'school_years');
  assert.equal(s.turn, 7);
  assert.equal(s.phase, 'walk'); // never replay the intro mid-conversation
  assert.equal(s.subscriberName, null);
  assert.equal(s.recapPending, false);
  assert.deepEqual(s.photoDeclinedChapters, []);
  assert.deepEqual(s.photoAskedChapters, []);
  assert.equal(s.photoAskPending, false);
  assert.equal(s.pendingNameClarification, null);
  assert.deepEqual(s.carry, { from_first_light: 'the kitchen' });
});

test('revive preserves v6 photo-walk state and drops junk chapter ids', () => {
  const s = reviveSnapshot({
    ...initialStateSnapshot(),
    photoDeclinedChapters: ['becoming', 'not_a_chapter'],
    photoAskedChapters: ['first_light'],
    photoAskPending: true,
  });
  assert.deepEqual(s.photoDeclinedChapters, ['becoming']);
  assert.deepEqual(s.photoAskedChapters, ['first_light']);
  assert.equal(s.photoAskPending, true);
});
