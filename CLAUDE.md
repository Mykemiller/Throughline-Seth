# Throughline

A multi-product family-history platform that weaves genealogical data, personal
photographs, historical enrichment, and AI-generated avatars into a living,
navigable tapestry.

**The River is universal. Every family weaves their thread through it.**

This file is loaded into every Claude Code session. Keep it to durable rules and
orientation. Detailed specs live in Notion (linked below) — **do not duplicate them here.**

*Last refreshed: 2026-06-09.*

-----

## Where the truth lives

- **Notion** is the single source of truth for specs, design, and status. Do not invent specs; read Notion.
- **Jira** (project `THOUG`, `mykesfoundry.atlassian.net`, cloud ID `2cdbb127-783f-4329-bec5-26223393fcfe`) is the authoritative tracker for epics/stories/tasks.
- **Supabase** Postgres (project `uuzzfeaevxilwizaittq`) is the single source of truth for all application data. The live schema is current — code against it; never assume columns.
- This repo holds code only. When code and a spec disagree, the spec wins — stop and surface it.

Key Notion pages: Project Hub `32f89a0c168081059b13ec225170e441` · First Thread Design Spec `37089a0c1680817eaaa4d430849b41bd` · Seth Vision & Architecture Spec v0.2 `37a89a0c16808174b54cebe9b4bab0f2` · Brand Bible v2 `33289a0c1680815c996cedb8fde4429f`.

-----

## Current workstream (read before building)

**Active:** TL-E13 — Companion: Seth, the voice First Thread agent. Gemini pre-build review complete, **migration 005 applied**, spec at **v0.2**, build phase open.

- **THOUG-129 (E13-T1)** — Hume EVI 3 BYO-LLM(Claude) runtime + ZDR — is the active critical-path task.
- **THOUG-131 (E13-T3)** — seven-chapter state machine + `sethScaffold.ts` — In Progress.
- The runtime consumes `sethScaffold.ts`; it does not redefine prompt content.
- Architecture is fully specified in the Seth v0.2 spec (Notion). Follow it.

-----

## Stack & layout

- **Web** (host surface first): React + TypeScript + Vite. Lives under `apps/web`.
- **Native** (later): SwiftUI iPad/iPhone. Web validates the conversation model before any Swift.
- **Data:** Supabase Postgres + pgvector (metadata, single source of truth), Supabase Storage (photos), Cloudflare R2 (video).
- **Voice:** Hume EVI 3 (live two-way, ZDR) with Claude as BYO-LLM. ElevenLabs is for Walt/produced clips only — not the live Companion.
- **Brand tokens:** `tokens.css` at repo root. Parchment `#F2E6BC`, Deep River `#1E2A3A`; Cormorant Garamond (display), DM Sans (UI). Honor the Brand Bible.
- **Env / secrets:** real values in `.env` (gitignored); template in `.env.example`. Web env layer is split by trust boundary: `apps/web/src/env.ts` is client-safe (`VITE_*` only — Supabase URL + anon key), `apps/web/server/env.ts` holds all secrets (server only, browser-guarded; consumed by the Companion/voice runtime). Vite inlines `VITE_*` into the browser bundle, so **never** give a server secret a `VITE_` prefix. Missing var → fail fast, don't default.

-----

## Durable rules — non-negotiable

1. **Reverence Principle (P0).** On any closed-door signal, stop that topic/person/period permanently with one gentle acknowledgment; never re-approach; revisit only on subscriber initiative. A deterministic pre-filter runs *before* Claude in the voice loop. Closed scopes staying closed is a ship gate (adversarial QA).
1. **No confabulation.** Never invent facts about a subscriber’s own life. Grounded retrieval only.
1. **Never write to the River silently.** Writes happen only from a confirmed structured payload, never from the spoken/free-text channel.
1. **Tab A / Tab B.** Tab A = universal River (visible to all, `subscriber_id IS NULL`). Tab B = a family’s own thread (owner-scoped, never shared, never canonical). First Thread personal Moments default to **private** — set `visibility='private'` explicitly in the writer; do not rely on the DB default.
1. **Schema before build.** Do not write or run database migrations from a build task. Migration 005 is live. If a column seems missing, stop and surface it — do not improvise schema.
1. **Secrets via env only.** Hume / Anthropic / Supabase keys come from environment variables. Never hardcode, never commit. If a var is missing, stop and ask.
1. **ZDR + owner-voice gate.** No real-subscriber audio until the Hume DPA (THOUG-99) closes. Build and spike on the owner’s own voice only.
1. **Child safety & governance.** Avatar production for deceased family/historical figures only — never living persons. AI-generated historical figures require an interpretation disclosure. Chief Joseph / Indigenous figures require cultural-sensitivity review before publication.
1. **Never-say (user-facing copy):** “Unlock”, “Seamlessly”, “AI-powered”, “Dive into”, “Your journey”. Voice is warm, unhurried, historically literate, personal.

-----

## Working conventions

- **Companions are a role.** Seth (scripted, for female subscribers) and Miriam (conversational, for male subscribers) are the two named Companions. Stamp provenance on the row: `companion = 'seth' | 'miriam'`.
- **Career Arc:** group work Moments with the flat `cluster_tags text[]` (`@> ARRAY['career_map']`) + optional `cluster_root_id` anchor — not a parent/child tree.
- **Feature flags:** new voice work ships behind `first_thread_voice`, off by default.
- **Commits:** small, focused, clear messages. If a spec point is ambiguous or a rule blocks you, stop and ask rather than improvising.
- **Jira (when asked to update):** transition `21` = In Progress, `31` = Done; comment before transitioning; stories parented to epics.

-----

## What this file is not

Not a spec dump. Acceptance criteria, data dictionaries, and design detail live in Notion. This file exists so a fresh session inherits the locked decisions and guardrails automatically — keep it lean and current.
