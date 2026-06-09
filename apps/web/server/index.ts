/**
 * Server stub.
 *
 * Confirms the server-only env loads and is typed. The real Companion / voice
 * runtime (THOUG-129) will import `serverEnv` from here. Run with:
 *
 *   cd apps/web && npm run server
 *
 * (the `server` script sources the repo-root .env, then runs this with Node's
 * built-in TypeScript stripping — requires Node >= 22.6).
 */
import { serverEnv } from "./env.ts";

// Mask secrets in logs — never print full key material.
const mask = (s: string) => `${s.slice(0, 6)}…(${s.length} chars)`;

console.log("Throughline server env loaded:");
console.log("  ANTHROPIC_MODEL     :", serverEnv.anthropic.model);
console.log("  ANTHROPIC_API_KEY   :", mask(serverEnv.anthropic.apiKey));
console.log("  NOTION_TOKEN        :", mask(serverEnv.notion.token));
console.log("  HUME_CONFIG_ID      :", serverEnv.hume.configId);
console.log("  HUME_API_KEY        :", mask(serverEnv.hume.apiKey));
console.log("  SUPABASE_URL        :", serverEnv.supabase.url);
console.log("  SUPABASE_SERVICE_KEY:", mask(serverEnv.supabase.serviceRoleKey));
console.log("  OPENAI_API_KEY      :", mask(serverEnv.openai.apiKey));
console.log("  FEATURE_VOICE_SETH  :", serverEnv.flags.voiceSeth ?? "(unset)");
