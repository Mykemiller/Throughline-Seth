/**
 * Throughline dev server (stub).
 *
 * A minimal Node HTTP server that proves the server-only env wiring and exposes
 * ONLY non-secret status. The real Companion / voice runtime (THOUG-129) and
 * River writers will live behind this boundary, consuming `serverEnv`.
 *
 * Run with:  cd apps/web && npm run server
 * (the `server` script sources the repo-root .env, then runs this under Node's
 * built-in TypeScript stripping — requires Node >= 22.6.)
 */
import { createServer } from "node:http";
import { serverEnv } from "./env.ts";

const PORT = Number(process.env.PORT ?? 8787);

// Mask secrets in logs — never print full key material.
const mask = (s: string) => `${s.slice(0, 6)}…(${s.length} chars)`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  res.setHeader("Content-Type", "application/json");

  if (url.pathname === "/api/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Non-secret integration status. Reports only WHETHER each integration is
  // configured — never the values. Safe to surface to the client.
  if (url.pathname === "/api/config") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        anthropicModel: serverEnv.anthropic.model,
        integrations: {
          anthropic: Boolean(serverEnv.anthropic.apiKey),
          notion: Boolean(serverEnv.notion.token),
          hume: Boolean(serverEnv.hume.apiKey),
          supabase: Boolean(serverEnv.supabase.serviceRoleKey),
          openai: Boolean(serverEnv.openai.apiKey),
        },
        // first_thread_voice ships off by default (CLAUDE.md). This only reports
        // whether Seth's voice is configured, not that it is enabled.
        voiceSethConfigured: Boolean(serverEnv.flags.voiceSeth),
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`Throughline server listening on http://localhost:${PORT}`);
  console.log("Server env loaded (masked):");
  console.log("  ANTHROPIC_MODEL     :", serverEnv.anthropic.model);
  console.log("  ANTHROPIC_API_KEY   :", mask(serverEnv.anthropic.apiKey));
  console.log("  NOTION_TOKEN        :", mask(serverEnv.notion.token));
  console.log("  HUME_CONFIG_ID      :", serverEnv.hume.configId);
  console.log("  HUME_API_KEY        :", mask(serverEnv.hume.apiKey));
  console.log("  SUPABASE_URL        :", serverEnv.supabase.url);
  console.log("  SUPABASE_SERVICE_KEY:", mask(serverEnv.supabase.serviceRoleKey));
  console.log("  OPENAI_API_KEY      :", mask(serverEnv.openai.apiKey));
  console.log("  FEATURE_VOICE_SETH  :", serverEnv.flags.voiceSeth ?? "(unset)");
});
