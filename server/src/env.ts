/**
 * Environment loading + validation. All secrets come from the environment;
 * nothing is hardcoded. If the voice flag is on and a required var is missing,
 * we STOP with a clear message rather than improvising (durable rule #6).
 */
import 'dotenv/config';

function bool(v: string | undefined): boolean {
  return v === 'true' || v === '1' || v === 'yes';
}

/** The feature flag. The entire voice runtime is dormant unless this is on. */
export const FIRST_THREAD_VOICE = bool(process.env.FIRST_THREAD_VOICE);

export const PORT = Number(process.env.PORT ?? 8787);
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-4-8';

/** Vars required for the live loop. Validated only when the flag is on. */
const REQUIRED_WHEN_ENABLED = [
  'HUME_API_KEY',
  'HUME_SECRET_KEY',
  'HUME_CONFIG_ID',
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OWNER_SUBSCRIBER_ID',
] as const;

export interface Secrets {
  HUME_API_KEY: string;
  HUME_SECRET_KEY: string;
  HUME_CONFIG_ID: string;
  ANTHROPIC_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OWNER_SUBSCRIBER_ID: string;
}

/**
 * Returns validated secrets, or throws with the exact list of what's missing.
 * Call this lazily (when the flag is on) so a flag-off boot never needs keys.
 */
export function requireSecrets(): Secrets {
  const missing = REQUIRED_WHEN_ENABLED.filter((k) => !process.env[k] || process.env[k]!.trim() === '');
  if (missing.length > 0) {
    throw new Error(
      `first_thread_voice is enabled but required environment variables are missing: ${missing.join(', ')}. ` +
        `Set them (see .env.example) — secrets are never hardcoded.`,
    );
  }
  return {
    HUME_API_KEY: process.env.HUME_API_KEY!,
    HUME_SECRET_KEY: process.env.HUME_SECRET_KEY!,
    HUME_CONFIG_ID: process.env.HUME_CONFIG_ID!,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    OWNER_SUBSCRIBER_ID: process.env.OWNER_SUBSCRIBER_ID!,
  };
}
