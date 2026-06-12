/**
 * flowEngine.ts — minimal seven-chapter state transitions.
 *
 * OWNERSHIP: THOUG-131 (E13-T3). This is a thin, deterministic placeholder that
 * advances chapter→chapter, enforces the one-follow-up rule, and records
 * Reverence closures into the snapshot. THOUG-131 will flesh out transition
 * carries and milestone-extraction hooks. The voice runtime (THOUG-129) drives
 * it but does not own the chapter logic.
 *
 * Pure functions over SessionStateSnapshot — no I/O. The runtime persists the
 * returned snapshot to rot_capture_sessions.state_snapshot.
 */

import type { ChapterId, ClosedScope, SessionStateSnapshot } from './types.js';
import { CHAPTER_ORDER } from './sethScaffold.js';

/** Advance to the next chapter, resetting the per-chapter follow-up budget. */
export function advanceChapter(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  const idx = CHAPTER_ORDER.indexOf(snapshot.chapterId);
  const next = CHAPTER_ORDER[Math.min(idx + 1, CHAPTER_ORDER.length - 1)]!;
  return { ...snapshot, chapterId: next, followUpSpent: false };
}

/** Mark the current chapter's single follow-up as spent. */
export function spendFollowUp(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  return { ...snapshot, followUpSpent: true };
}

/** True if we're already at the final chapter. */
export function isFinalChapter(snapshot: SessionStateSnapshot): boolean {
  return snapshot.chapterId === CHAPTER_ORDER[CHAPTER_ORDER.length - 1];
}

/**
 * Record a closed-door scope into the snapshot (idempotent on phrase). The
 * Reverence Principle means once closed, always closed — so we never remove
 * from this list.
 */
export function closeScope(
  snapshot: SessionStateSnapshot,
  phrase: string,
  closedAt: string = new Date().toISOString(),
): SessionStateSnapshot {
  const already = snapshot.closedScopes.some((s) => s.phrase === phrase);
  if (already) return snapshot;
  const scope: ClosedScope = { phrase, closedAt, chapterId: snapshot.chapterId };
  return { ...snapshot, closedScopes: [...snapshot.closedScopes, scope] };
}

/** Stash a value to carry into later chapters (e.g. a remembered name). */
export function carry(snapshot: SessionStateSnapshot, key: string, value: string): SessionStateSnapshot {
  return { ...snapshot, carry: { ...snapshot.carry, [key]: value } };
}

export function currentChapter(snapshot: SessionStateSnapshot): ChapterId {
  return snapshot.chapterId;
}
