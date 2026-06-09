/**
 * Client environment access (browser-safe).
 *
 * Vite inlines every `VITE_*` var into the shipped browser bundle, so ONLY
 * client-safe values belong here: the Supabase project URL and the anon
 * (public) key. Never read or add a secret with a `VITE_` prefix — that would
 * leak it to every visitor. Server secrets live in `server/env.ts`.
 * See CLAUDE.md rule #6 (Secrets via env only).
 */

function required(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (value == null || String(value).trim() === "") {
    // Fail fast rather than improvise a default (CLAUDE.md rule #6).
    throw new Error(`Missing required client env var: ${name}`);
  }
  return String(value);
}

export const clientEnv = {
  supabase: {
    url: required("VITE_SUPABASE_URL"),
    anonKey: required("VITE_SUPABASE_ANON_KEY"),
  },
} as const;

export type ClientEnv = typeof clientEnv;
