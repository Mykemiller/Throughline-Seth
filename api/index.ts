/**
 * Vercel entry — the entire Express app (CLM endpoint, Hume token minter,
 * sessions, exchanges, photos) runs as one serverless function. vercel.json
 * rewrites /api/* here. SSE streaming (the Hume BYO-LLM turn) is supported on
 * Vercel's Node runtime. Locally, `npm run dev:server` still runs the same app
 * on :8787 — this file is Vercel-only glue.
 */
import { app } from '../server/src/index.js';

export default app;
