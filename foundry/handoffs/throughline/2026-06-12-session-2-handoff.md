# Foundry Handoff — Throughline
**Date:** 2026-06-12
**Session #:** 2
**Foundry Stage:** Build
**Sprint / Phase:** TL-E13 · Companion: Seth (voice First Thread) — prototype sprint
**Prepared by:** Claude (Fable 5, Cowork)
**Handoff to:** Next Claude session / Myke (operator)

---

## 1. Session Summary
Built the Seth voice-companion prototype end-to-end and promoted it to canonical `main` on GitHub. The seven-chapter scaffold graduated from stub to the locked v0.2 spine with canonical Design-Spec wordings (THOUG-131 → Done); River writes are real and confirm-only with idempotency; the photo pipeline (client-side EXIF parse + strip, retain-original opt-in, pin to active Moment, commentary → Layer-3 Story) is built; resume works; the adversarial reverence QA suite passes (22/22 tests, typecheck green). Four batched decisions were resolved by Myke: Vercel hosting, PWA surface, voice-branch promotion to main, owner-row insert. The one remaining gate to a live run is Vercel env vars (secrets, Myke-only) + the Hume config CLM URL.

---

## 2. Project State Snapshot

| Dimension          | Current State                                      |
|--------------------|----------------------------------------------------|
| Foundry Stage      | Build                                              |
| Gate Status        | Pending — live owner-voice run (THOUG-102) gates Build acceptance |
| Jira Epic          | THOUG-120 (TL-E13 · Companion: Seth)               |
| GitHub Repo        | https://github.com/Mykemiller/Throughline- — `main` canonical @ f6d962a, PRs #1/#2 closed superseded |
| Notion Brief       | Seth Vision & Architecture Spec v0.2 (37a89a0c16808174b54cebe9b4bab0f2); Hub Session Pulse updated 2026-06-12 |
| Airtable Score     | Not yet scored                                     |
| Revenue Status     | Pre-revenue                                        |
| CFO Flag           | None                                               |

---

## 3. Active Decisions & Rationale

1. **Vercel hosts both web and server** — Matches the goal statement ("ready to be deployed by Vercel"); one platform, SSE streaming supported on the Node runtime, direct connector available. Supersedes the older Cloudflare Pages wording.
2. **iOS surface is the PWA in mobile Safari** — Per CLAUDE.md phasing: web validates the conversation model before any Swift. Weaver Xcode starter stays parked.
3. **`claude/seth-prototype-e2e` promoted to canonical `main`** — It contains the reconciled CLAUDE.md and the full runtime; PRs #1/#2 closed as superseded rather than merged, avoiding a three-way merge of stale branches.
4. **Spec chapter spine replaced the stub's placeholder chapters** — `ChapterId` is now `first_light … last_night`; spec wins over code by durable rule. Legacy v1 snapshots are revived safely (`reviveSnapshot`), so no data is stranded.
5. **Chapter advance is engine-gated, not model-gated** — Claude can only *signal* `chapter_complete`; the engine refuses unless the chapter has ≥1 confirmed Moment (never forced) and the payload names the current chapter. Keeps bounded latitude enforceable.
6. **Owner subscriber row created** — `8ce705a7-d88a-45e3-b31d-fd805db13f33` (subscribers). Required because `rot_capture_sessions.subscriber_id` is NOT NULL; this is `OWNER_SUBSCRIBER_ID`.

---

## 4. Open Threads

- Layer-3 Story ↔ photo Moment linkage uses `cluster_root_id` as the anchor (no dedicated parent FK in schema) → confirm this reading against the spec owner, or surface a schema need through proper channels.
- Closed-topic token breadth: closing "what the work cost me" tokenizes to `work, cost`, which gates all later work prompts — conservative-safe but possibly over-broad → review with real transcripts after the live run.
- `subscriber_closed_topics` rows are written per closure but never *read back* into a fresh session for the same subscriber (closures persist via the session snapshot today; durable cross-session enforcement of DB rows into new sessions) → wire `isClosed` to load from DB at session create.
- One-follow-up accounting is approximate (spent after the first Claude turn per chapter) → tighten with real turn semantics once live transcripts exist.
- Hume EVI session-settings key for `custom_session_id` should be verified against the current Hume SDK during the first live run (named `customSessionId` in `@humeai/voice-react` today).
- Validation rows in Supabase are labeled and reversible: session `0e0d0547-3552-44d6-9257-97315dd1b151` (abandoned), moment `c60bdde6-bebe-4087-b38e-95c5d1473a38`, closed-topic `e960f24c-82c3-48cc-bc9f-bb55e1fcabb0` → delete after the real spike lands, or keep as audit.

---

## 5. Next Session Priorities

1. **Vercel import + env vars (Myke, ~10 min)** — vercel.com → Add New Project → import `Mykemiller/Throughline-` (root, `main`). Set: `FIRST_THREAD_VOICE=true`, `VITE_FIRST_THREAD_VOICE=true`, `HUME_API_KEY`, `HUME_SECRET_KEY`, `HUME_CONFIG_ID`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_SUBSCRIBER_ID=8ce705a7-d88a-45e3-b31d-fd805db13f33`. Smoke: `GET /api/health`.
2. **Hume config** — in the Hume dashboard set the EVI 3 config's custom language model URL to `https://<deployment>/api/clm/chat/completions`, confirm ZDR on, stock voice for now (THOUG-130 pending).
3. **Run THOUG-102 → THOUG-129 Done** — iPhone Safari (or installed PWA): full Chapter-1→7 walk on Myke's own voice, confirm a Moment aloud, pin a photo mid-session, give commentary. Capture: `rot_moments`/`first_thread_exchanges` row IDs, screen recording, Hume request audit per `docs/zdr-verification.md`. Post evidence to THOUG-102/129 and transition 129 → Done (id 31).
4. **Reverence live drill (E13-07 ship gate)** — in-voice: close a door, paraphrase-pressure it, resume the session, verify it stays closed; attach to THOUG-127/E13-07.
5. **Wire DB-backed closed topics into new sessions** — read `subscriber_closed_topics` at session create so closures bind across sessions, not just resumes.

---

## 6. Agent Handoff Notes

- Jira cloud ID is `2cdbb127-783f-4329-bec5-26223393fcfe` (mykesfoundry.atlassian.net), project THOUG; transitions: 21 = In Progress, 31 = Done. Comment before transitioning.
- **Do not assume** `~/Documents/current-project/Throughline` on Myke's Mac is the Throughline repo — its git remote points at `v0-faraday-daily-challenge`. Push via a fresh clone (gh CLI is authenticated as Mykemiller).
- The sandbox cannot push to GitHub; this session pushed via Mac automation (`gh` + fresh clone in /tmp). A git bundle of the session also sits in the Cowork outputs folder.
- Never read `.env`/`Env.txt`; secrets are Myke-set in Vercel only. The server fail-fast lists missing vars by name.
- The runtime consumes `sethScaffold.ts` — never inline prompt content. The scaffold owns words; `flowEngine.ts` owns behavior; `clm.ts` owns the turn order (pre-filter → in-memory block → durable write → gate → confirm → Claude → payload → persist).
- All First Thread writes must set `visibility='private'` explicitly (DB default is `public` — B4).
- ElevenLabs is Walt-only; the live Companion voice is Hume.
- Validation/test rows in Supabase are clearly labeled `[schema validation]` — don't mistake them for real subscriber data.

---

## 7. Blockers & Dependencies

| Blocker                | Blocking Because            | Resolution Path           |
|------------------------|-----------------------------|---------------------------|
| Vercel env vars not set | Secrets are Myke-only by design; deploy boots flag-off without them | Myke imports repo + sets 9 vars (~10 min) |
| Hume DPA (THOUG-99, P0) | No real-subscriber audio until closed | Owner-voice-only until DPA lands; paper chase with Hume |
| Seth cloned voice (THOUG-130) | THOUG-98 candidates not ready | Spike on stock Hume voice; config-only swap later |

---

## 8. Foundry Loop Signal
Hume EVI 3's BYO-LLM pattern (voice vendor owns transport/turn-taking, your server owns the brain) proved clean to implement behind one SSE endpoint — a reusable seam for Miriam (TL-E14) and any future voice agent in the Foundry.

---

## 9. Learning Ledger Flag
**Tag:** Throughline
**Insight:** Deterministic safety floors (regex pre-filter, token-matched closed scopes, engine-gated advances, confirm-only writes) can carry P0 guarantees independent of model behavior — the adversarial QA suite passes with zero model calls. Design pattern worth reusing for Miriam's no-confabulation P0.
**Trigger Learning Steward:** Yes

---

## 10. Handoff Confidence
**Score:** 4
**Reason:** All state, decisions, and evidence are captured with IDs; it's a 5 once the live owner-voice run validates the loop and its evidence lands in THOUG-102/129.
