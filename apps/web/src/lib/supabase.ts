/**
 * Browser Supabase client.
 *
 * Uses the anon (public) key only — this runs in the browser and is subject to
 * Row Level Security. Privileged access (service-role key) lives server-side in
 * apps/web/server/env.ts and must never be used here. See CLAUDE.md rule #6.
 */
import { createClient } from "@supabase/supabase-js";
import { clientEnv } from "../env";

export const supabase = createClient(
  clientEnv.supabase.url,
  clientEnv.supabase.anonKey,
);

export type SupabaseClient = typeof supabase;
