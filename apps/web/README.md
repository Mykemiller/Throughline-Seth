# @throughline/web

The web host surface for Throughline — React + TypeScript + Vite.

## Environment

Secrets are read from the repo-root `.env` (gitignored; template in
`.env.example`). The env layer is split by trust boundary:

- **`src/env.ts`** — client, browser-safe. Reads only `VITE_*` vars (Supabase
  URL + anon key). Vite inlines these into the shipped bundle.
- **`server/env.ts`** — server only. Reads every secret (Anthropic, Hume,
  Notion, OpenAI, Supabase service-role key) and refuses to load in a browser.

**Never give a server secret a `VITE_` prefix** — it would ship to every
visitor. See `CLAUDE.md` rule #6.

## Commands

```bash
npm install          # install deps (not run here — no lockfile committed yet)

npm run dev          # Vite dev server (client)
npm run build        # typecheck + production build
npm run typecheck    # client typecheck
npm run server       # sources ../../.env and runs the Node server stub
```

The `server` script needs **Node >= 22.6** (uses built-in TypeScript stripping).
It exposes non-secret endpoints only:

- `GET /api/health` → `{ "status": "ok" }`
- `GET /api/config` → which integrations are configured (booleans, no values)

## Layout

```
apps/web/
  index.html          # Vite entry
  src/
    main.tsx          # React mount (imports repo-root tokens.css)
    App.tsx           # orientation landing
    env.ts            # client env (VITE_* only)
    lib/supabase.ts   # browser Supabase client (anon key)
    styles/global.css # base styles on brand tokens
  server/
    env.ts            # server-only env (secrets, browser-guarded)
    index.ts          # dev server stub
```

Brand tokens are the repo-root `tokens.css` (Brand Bible v2) — the single
source of truth for color and type. Do not duplicate brand values here.
