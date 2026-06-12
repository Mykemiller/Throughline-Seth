# First Thread voice runtime (THOUG-129)

A live two-way voice loop for **Seth**, the First Thread Companion: **Hume EVI 3**
owns the voice (transport, STT, prosody, turn-taking, barge-in, TTS) and
**Claude** is the BYO-LLM brain (reasoning + the scripted First Thread flow).
Everything ships behind the `first_thread_voice` flag, **off by default**.

## Architecture

```
 Browser (apps/web)                 Server (server/)                Providers
 ─────────────────                  ───────────────                ─────────
 mic / playback  ── audio ─────►  ▢ Hume EVI 3 socket  ◄───────────  Hume (ZDR)
 VoiceProvider                    │  (token from /api/hume/token)
   │ transcript events            │
   │ (text only)                  ▼  per assistant turn, Hume calls:
   ├─ POST /api/exchanges ─────►  POST /api/clm/chat/completions  (BYO-LLM)
   │   (subscriber/companion,        1. reverence pre-filter (P0, deterministic)
   │    interrupted flag)            2. Claude streams Seth's spoken text ──► Hume (TTS)
   └─ POST /api/sessions             3. optional typed payload (tool use, NOT spoken)
                                     4. state_snapshot persisted          │
                                  Supabase (service role) ◄───────────────┘
                                    rot_capture_sessions, first_thread_exchanges
                                  Anthropic (Claude, text only) ◄──────────
```

Why a server: Hume's BYO-LLM ("custom language model") calls **your** endpoint
and you stream Claude back to it. That endpoint needs the Anthropic key, runs
the P0 reverence pre-filter, and persists — so it cannot live in the browser.

Key files:
- `packages/shared/src/reverenceFilter.ts` — deterministic P0 closed-door filter
- `packages/shared/src/sethScaffold.ts` — **THOUG-131** prompt scaffold (consumed, not redefined)
- `server/src/clm.ts` — Hume BYO-LLM endpoint (reverence → Claude → SSE)
- `server/src/claude.ts` — Claude streaming + two-channel structured output
- `server/src/riverWrites.ts` — River-write boundary (**stubbed** for THOUG-129)
- `apps/web/src/VoiceSession.tsx` — EVI VoiceProvider + Seth panel
- `apps/web/src/useTranscriptPersistence.ts` — uttered-text persistence + barge-in
- `docs/zdr-verification.md` — ZDR audit method + evidence (THOUG-99/100)

## Run it

1. `cp .env.example .env` and fill in secrets (server stops with a clear message
   if any are missing). Set both `FIRST_THREAD_VOICE=true` and
   `VITE_FIRST_THREAD_VOICE=true`.
2. On the Hume side, configure the EVI config (`HUME_CONFIG_ID`) with:
   - **ZDR enabled** (see `docs/zdr-verification.md`).
   - **Custom language model** (BYO-LLM) pointing at your server's
     `POST /api/clm/chat/completions` (OpenAI-compatible SSE).
3. `npm install`
4. `npm run dev` (runs the server on `:8787` and Vite on `:5173`; Vite proxies
   `/api` to the server).
5. Open the web app, click **Begin with Seth**, and speak. Barge-in works;
   say a closed-door phrase ("I'd rather not talk about that") to see the
   deterministic reverence intervention override Claude's next turn.

## Checks

- `npm run typecheck` (per workspace) — types against the live schema.
- `npm test --workspace @throughline/shared` — reverence pre-filter tests.

## Boundaries honored (durable rules)

- **Reverence (P0):** deterministic filter runs *before* Claude; a hit overrides
  the next prompt even if Claude omits a payload. Closed scopes persist in
  `state_snapshot` and are never re-approached.
- **No silent River writes:** the spoken channel never writes. Drafts ride a
  separate tool-use channel and are **stubbed** (`riverWrites.ts`) pending the
  confirm/commit path in later tasks.
- **Schema before build:** no migrations written; code targets migration-005
  columns exactly.
- **Secrets via env only;** **owner-voice only** (`OWNER_SUBSCRIBER_ID`);
  **flag off by default.**

## Session prototype additions (2026-06-12 — E13 build session)

**Seven-chapter flow is real (THOUG-131).** `sethScaffold.ts` graduated from
`0.2.0-stub` to `0.2.0`: the locked spine (First Light → The School Years →
Becoming → The World You Built → What Stayed → Still Becoming → Last Night),
canonical opening wordings from the Design Spec v0.3, The Fork branch inside
Becoming, the three-act Career Arc (`cluster_tags ['career_map']`), nuclear
episode focus per chapter, and per-chapter dynamic pacing
(`silenceToleranceMs`). `flowEngine.ts` enforces order, the one-bounded-
follow-up rule, transition carries, the chapter completeness rule (≥1
confirmed Moment, never forced), and the tokenized closed-topic pre-prompt
gate. The snapshot is `v:2`; `reviveSnapshot()` upgrades any legacy shape on
resume without losing closures (E13-08).

**Moments are written for real — only via confirmation (E13-03/04).**
`riverWrites.ts` is un-stubbed. The only path to `rot_moments` is: Claude
stages a `moment_draft`/`story_draft` on the tool channel → Seth reflects it
back aloud → the subscriber's spoken **yes** (deterministic `detectConfirmation`;
decline wins on ambiguity) → insert with `companion='seth'`,
`source='first_thread_voice'`, `medium='voice'`, explicit
`visibility='private'`, `chapter`, `layer` (2 Moment / 3 Story) and the
deterministic `sync_idempotency_key = sha256(subscriber|session|chapter|turn)`
(looked up before insert, so retries merge). Reverence closures also persist to
`subscriber_closed_topics` with normalized `match_tokens`.

**Photos (E13-05/06, THOUG-132).** "Add a photograph" mid-session: the browser
parses EXIF date/GPS into proposed text, strips ALL metadata via canvas
re-encode (`exif.ts`, no third-party parser), and uploads only the clean
derivative — the untouched original only on the explicit "keep my original"
opt-in (`media_assets.retain_original`). The server pins the asset to the
active Moment and marks `pendingPhoto` in the snapshot, so Seth invites spoken
commentary on his next turn; the confirmed commentary commits as a Layer 3
Story anchored via `cluster_root_id`.

**Resume (E13-08).** `GET /api/sessions/resumable` returns the owner's most
recent `in_progress` session; the web app offers "Continue with Seth" and the
chapter, carries, and closed doors come back exactly as left.

**PWA.** Installable from mobile Safari (manifest + icons + minimal service
worker; no fetch caching — the live loop is never intercepted). Mic permission
is requested on the "Begin with Seth" tap (a user gesture, required by iOS).
Requires HTTPS in production.

## Deploying on Vercel

One project, repo root:
- `vercel.json` builds `apps/web` (static, `apps/web/dist`) and runs the whole
  Express app as a single function (`api/index.ts`); `/api/*` is rewritten to it.
- Set env vars in Vercel (Production): `FIRST_THREAD_VOICE=true`,
  `VITE_FIRST_THREAD_VOICE=true`, `HUME_API_KEY`, `HUME_SECRET_KEY`,
  `HUME_CONFIG_ID`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_SUBSCRIBER_ID`.
- Point the Hume EVI config's custom language model URL at
  `https://<deployment>/api/clm/chat/completions`.
- Smoke: `GET /api/health` → `{ ok: true, firstThreadVoice: true }`.
