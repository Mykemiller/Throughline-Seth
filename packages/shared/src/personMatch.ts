/**
 * personMatch.ts — AC11 name resolution against the `persons` family record
 * (117 GEDCOM rows), THOUG-132 Photo Walk.
 *
 * Pure classification only — the server fetches candidate rows (service role;
 * the table is small) and calls classifyPersonMatch. Tiers, in order:
 *
 *   exact     — full_name, or given_name + surname (case-insensitive)
 *   fuzzy     — single candidate via given-name token, prefix, or alt_names
 *   ambiguous — more than one candidate at the best tier reached
 *   unmatched — nothing plausible
 *
 * D4 (one-and-done): an ambiguous result carries candidate summaries for
 * Seth's single clarifying question; resolveClarification reads the reply
 * deterministically. If it doesn't resolve, the row stays 'ambiguous' — never
 * interrogate.
 */

import type { PersonMatchConfidence } from './types.js';

/** The columns the matcher needs from a `persons` row (verified live 2026-07-03). */
export interface PersonRecord {
  id: string;
  full_name: string;
  given_name: string | null;
  surname: string | null;
  birth_year: number | null;
  /** jsonb — an array of alternate-name strings when present. */
  alt_names: unknown;
}

export interface PersonMatchResult {
  confidence: PersonMatchConfidence;
  /** Set only for exact / fuzzy (a single resolved person). */
  personId: string | null;
  /** Set for ambiguous: everyone still in contention. */
  candidates: PersonRecord[];
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function altNames(p: PersonRecord): string[] {
  if (!Array.isArray(p.alt_names)) return [];
  return (p.alt_names as unknown[]).filter((n): n is string => typeof n === 'string');
}

/** Classify one spoken name against the family record (AC11 tiers). */
export function classifyPersonMatch(
  spokenName: string,
  persons: PersonRecord[],
): PersonMatchResult {
  const name = norm(spokenName);
  if (!name) return { confidence: 'unmatched', personId: null, candidates: [] };

  // Tier 1 — exact: full_name, or given_name + surname.
  const exact = persons.filter((p) => {
    if (norm(p.full_name) === name) return true;
    if (p.given_name && p.surname && norm(`${p.given_name} ${p.surname}`) === name) return true;
    return false;
  });
  if (exact.length === 1) return { confidence: 'exact', personId: exact[0]!.id, candidates: [] };
  if (exact.length > 1) return { confidence: 'ambiguous', personId: null, candidates: exact };

  // Tier 2 — fuzzy: given-name token match, prefix (≥3 chars), or alt_names.
  const first = name.split(' ')[0]!;
  const fuzzy = persons.filter((p) => {
    const given = p.given_name ? norm(p.given_name) : '';
    const givenTokens = given.split(' ').filter(Boolean);
    // "ruth" spoken → given_name "Ruth" or "Ruth Ann"; "mary beth" → given "Mary Beth".
    if (given === name || givenTokens[0] === name || givenTokens.includes(first)) return true;
    // Prefix pet-forms ("Rob" → "Robert"), only with enough signal.
    if (first.length >= 3 && givenTokens.some((t) => t.startsWith(first))) return true;
    // alt_names entries, exact or first-token.
    return altNames(p).some((a) => {
      const an = norm(a);
      return an === name || an.split(' ')[0] === first;
    });
  });
  if (fuzzy.length === 1) return { confidence: 'fuzzy', personId: fuzzy[0]!.id, candidates: [] };
  if (fuzzy.length > 1) return { confidence: 'ambiguous', personId: null, candidates: fuzzy };

  return { confidence: 'unmatched', personId: null, candidates: [] };
}

/** A short spoken-safe descriptor for the one clarifying question (D4). */
export function personSummary(p: PersonRecord): string {
  return p.birth_year ? `${p.full_name}, born ${p.birth_year}` : p.full_name;
}

/**
 * Read the reply to the single clarifying question deterministically: a
 * birth-year mention or a distinguishing name token settles it; anything else
 * stays ambiguous (one-and-done — we never ask twice).
 */
export function resolveClarification(
  reply: string,
  candidates: PersonRecord[],
): PersonRecord | null {
  const text = norm(reply);
  if (!text) return null;

  // A four-digit year unique to one candidate.
  const years = [...text.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  for (const y of years) {
    const hits = candidates.filter((c) => c.birth_year === y);
    if (hits.length === 1) return hits[0]!;
  }

  // A name token that appears in exactly one candidate's full_name/alt_names.
  const tokens = text.split(/[^a-z']+/).filter((t) => t.length >= 3);
  for (const t of tokens) {
    const hits = candidates.filter(
      (c) =>
        norm(c.full_name).split(' ').includes(t) ||
        altNames(c).some((a) => norm(a).split(' ').includes(t)),
    );
    if (hits.length === 1) return hits[0]!;
  }

  // "older"/"younger" when birth years fully order the candidates.
  const dated = candidates.filter((c) => c.birth_year != null);
  if (dated.length === candidates.length && candidates.length > 1) {
    const sorted = [...dated].sort((a, b) => a.birth_year! - b.birth_year!);
    if (/\b(older|oldest|elder|first)\b/.test(text)) return sorted[0]!;
    if (/\b(younger|youngest|later|second)\b/.test(text)) return sorted[sorted.length - 1]!;
  }

  return null;
}
