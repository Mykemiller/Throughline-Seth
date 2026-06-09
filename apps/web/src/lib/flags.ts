/**
 * Client feature flags.
 *
 * New voice work ships behind `first_thread_voice`, off by default (CLAUDE.md).
 * Flags default OFF and are opt-in via a `VITE_FEATURE_*` env var set to the
 * string "true". Anything else (unset, "false", "1", empty) reads as off.
 */
function flag(name: keyof ImportMetaEnv): boolean {
  return import.meta.env[name] === "true";
}

export const flags = {
  firstThreadVoice: flag("VITE_FEATURE_FIRST_THREAD_VOICE"),
} as const;

export type Flags = typeof flags;
