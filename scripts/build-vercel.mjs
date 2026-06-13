import { build } from 'esbuild';
// Web app (Vite) is built separately via its workspace script; this bundles
// the serverless API function so the @throughline/shared workspace TypeScript
// is inlined and only real npm deps remain external (resolved at runtime).
await build({
  entryPoints: ['server/src/vercelEntry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'api/index.mjs',
  external: ['express', 'cors', 'hume', '@supabase/supabase-js', '@anthropic-ai/sdk', 'dotenv'],
});
console.log('[build-vercel] api/index.mjs bundled');
