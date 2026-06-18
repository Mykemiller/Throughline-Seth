/**
 * Environment loading + validation. All secrets come from the environment;
 * nothing is hardcoded. If the voice flag is on and a required var is missing,
 * we STOP with a clear message rather than improvising (durable rule #6).
 */
import 'dotenv/config';

function bool(v: string | undefined): boolean {
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Trim a secret/config value and strip wrapping quotes accidentally pasted
 * around it. Values copied from rich-text sources arrive wrapped in smart
 * quotes (U+201C/U+201D) or straight quotes, and a single such character is
 * enough to corrupt an HTTP auth header or a model id — a stray "”" on the
 * end of an API key makes the SDK throw before the request leaves the process.
 * Anthropic keys and model ids never legitimately start/end with a quote or
 * whitespace, so this only ever removes corruption.
 */
function sanitize(v: string | undefined): string {
  return (v ?? '')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

/** The feature flag. The entire voice runtime is dormant unless this is on. */
export const FIRST_THREAD_VOICE = bool(process.env.FIRST_THREAD_VOICE);

export const PORT = Number(process.env.PORT ?? 8787);
export const CLAUDE_MODEL = sanitize(process.env.CLAUDE_MODEL) || 'claude-opus-4-8';

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
  // Sanitize first: a value that is only wrapping quotes (e.g. a pasted "")
  // collapses to empty and is correctly reported as missing rather than
  // silently shipped to an API as a corrupt credential.
  const missing = REQUIRED_WHEN_ENABLED.filter((k) => sanitize(process.env[k]) === '');
  if (missing.length > 0) {
    throw new Error(
      `first_thread_voice is enabled but required environment variables are missing: ${missing.join(', ')}. ` +
        `Set them (see .env.example) — secrets are never hardcoded.`,
    );
  }
  return {
    HUME_API_KEY: sanitize(process.env.HUME_API_KEY),
    HUME_SECRET_KEY: sanitize(process.env.HUME_SECRET_KEY),
    HUME_CONFIG_ID: sanitize(process.env.HUME_CONFIG_ID),
    ANTHROPIC_API_KEY: sanitize(process.env.ANTHROPIC_API_KEY),
    SUPABASE_URL: sanitize(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: sanitize(process.env.SUPABASE_SERVICE_ROLE_KEY),
    OWNER_SUBSCRIBER_ID: sanitize(process.env.OWNER_SUBSCRIBER_ID),
  };
}
