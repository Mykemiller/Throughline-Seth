/**
 * Supabase service-role access. SERVER ONLY — the service key never reaches the
 * browser. Every column written below exists in the live schema (migration 005,
 * verified); we never assume or invent columns.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  initialStateSnapshot,
  type ExchangeRole,
  type FirstThreadExchange,
  type SessionStateSnapshot,
  type SessionStatus,
} from '@throughline/shared';
import { requireSecrets } from './env.js';

let client: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (client) return client;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireSecrets();
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/**
 * Create the rot_capture_sessions row for a First Thread voice session.
 *   entry_point = 'first_thread', companion = 'seth', status = 'in_progress'
 * subscriber_id is NOT NULL — for THOUG-129 this is always the OWNER's row
 * (owner-voice-only gate). Returns the new session_id.
 */
export async function createSession(): Promise<{ sessionId: string; snapshot: SessionStateSnapshot }> {
  const { OWNER_SUBSCRIBER_ID } = requireSecrets();
  const snapshot = initialStateSnapshot();
  const { data, error } = await db()
    .from('rot_capture_sessions')
    .insert({
      subscriber_id: OWNER_SUBSCRIBER_ID,
      entry_point: 'first_thread',
      companion: 'seth',
      status: 'in_progress',
      state_snapshot: snapshot,
    })
    .select('session_id')
    .single();
  if (error) throw new Error(`createSession failed: ${error.message}`);
  return { sessionId: data.session_id as string, snapshot };
}

/** Read the current flow snapshot for recovery / per-turn context. */
export async function getSnapshot(sessionId: string): Promise<SessionStateSnapshot | null> {
  const { data, error } = await db()
    .from('rot_capture_sessions')
    .select('state_snapshot')
    .eq('session_id', sessionId)
    .single();
  if (error) return null;
  return (data?.state_snapshot as SessionStateSnapshot) ?? null;
}

/** Persist the flow snapshot (and optionally status) back to the session. */
export async function updateSession(
  sessionId: string,
  patch: { snapshot?: SessionStateSnapshot; status?: SessionStatus },
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.snapshot) update.state_snapshot = patch.snapshot;
  if (patch.status) {
    update.status = patch.status;
    if (patch.status === 'complete') update.completed_at = new Date().toISOString();
  }
  if (Object.keys(update).length === 0) return;
  const { error } = await db().from('rot_capture_sessions').update(update).eq('session_id', sessionId);
  if (error) throw new Error(`updateSession failed: ${error.message}`);
}

/**
 * Append one exchange. `content` must be ONLY what was actually uttered (or, for
 * a `system` row, a concise audit marker). Audio is never stored.
 */
export async function appendExchange(args: {
  sessionId: string;
  role: ExchangeRole;
  content: string;
  interrupted?: boolean;
}): Promise<FirstThreadExchange> {
  const { data, error } = await db()
    .from('first_thread_exchanges')
    .insert({
      session_id: args.sessionId,
      role: args.role,
      content: args.content,
      interrupted: args.interrupted ?? false,
    })
    .select('*')
    .single();
  if (error) throw new Error(`appendExchange failed: ${error.message}`);
  return data as FirstThreadExchange;
}
