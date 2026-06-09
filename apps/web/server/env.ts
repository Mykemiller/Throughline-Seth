/**
 * Server-only environment access.
 *
 * NEVER import this from client/browser code — it reads secrets (Supabase
 * service-role key, Anthropic, Hume, OpenAI, Notion) that must never reach the
 * browser bundle. The Companion / voice runtime (THOUG-129) consumes this.
 * See CLAUDE.md rule #6 (Secrets via env only).
 */

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/env.ts must never be imported from client code.");
}

function required(name: string): string {
  const value = process.env[name];
  if (value == null || value.trim() === "") {
    // Rule #6 / rule #5: stop on a missing var — do not improvise a default.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value != null && value.trim() !== "" ? value : undefined;
}

export const serverEnv = {
  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    // BYO-LLM for the Hume EVI 3 Companion runtime.
    model: optional("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6",
  },
  notion: {
    token: required("NOTION_TOKEN"),
  },
  hume: {
    apiKey: required("HUME_API_KEY"),
    secretKey: required("HUME_SECRET_KEY"),
    configId: required("HUME_CONFIG_ID"),
    sethVoiceId: required("HUME_SETH_VOICE_ID"),
  },
  supabase: {
    url: required("SUPABASE_URL"),
    anonKey: required("SUPABASE_ANON_KEY"),
    // Bypasses RLS — server only, never expose.
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  },
  openai: {
    apiKey: required("OPENAI_API_KEY"),
  },
  flags: {
    // first_thread_voice / Seth — off by default until wired (CLAUDE.md).
    voiceSeth: optional("FEATURE_VOICE_SETH"),
  },
} as const;

export type ServerEnv = typeof serverEnv;
