/**
 * Vercel serverless entry — the entire Express app as one function.
 *
 * Bundled at build time (see "build" script / vercel.json) with esbuild so the
 * @throughline/shared workspace TypeScript is INLINED. Real npm packages
 * (express, cors, hume, supabase, anthropic, dotenv) stay external and resolve
 * from node_modules at runtime — bundling those CJS libs into one ESM file
 * breaks their dynamic require()s.
 */
import { app } from './index.js';
export default app;
