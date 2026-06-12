/**
 * Supabase service-role access. SERVER ONLY — the service key never reaches the
 * browser. Every column written below exists in the live schema (migration 005,
 * verified); we never assume or invent columns.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  reviveSnapshot,
  initialStateSnapshot,
  type ExchangeRole,
  type FirstThreadExchange,
  type SessionStateSnapshot,
  type SessionStatus,
} from '@throughline/shared';
import { requireSecrets } from './env.js';

let client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  return db();
}

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

/** Session context the CLM turn needs: who + where the flow stands. */
export async function getSession(
  sessionId: string,
): Promise<{ subscriberId: string; snapshot: SessionStateSnapshot } | null> {
  const { data, error } = await db()
    .from('rot_capture_sessions')
    .select('subscriber_id, state_snapshot')
    .eq('session_id', sessionId)
    .single();
  if (error || !data) return null;
  return {
    subscriberId: data.subscriber_id as string,
    snapshot: reviveSnapshot(data.state_snapshot),
  };
}

/** Most recent resumable (in_progress) session for the owner, if any (E13-08). */
export async function findResumableSession(): Promise<
  { sessionId: string; snapshot: SessionStateSnapshot } | null
> {
  const { OWNER_SUBSCRIBER_ID } = requireSecrets();
  const { data, error } = await db()
    .from('rot_capture_sessions')
    .select('session_id, state_snapshot')
    .eq('subscriber_id', OWNER_SUBSCRIBER_ID)
    .eq('entry_point', 'first_thread')
    .eq('status', 'in_progress')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { sessionId: data.session_id as string, snapshot: reviveSnapshot(data.state_snapshot) };
}

const PHOTO_BUCKET = process.env.SUPABASE_PHOTO_BUCKET ?? 'first-thread-photos';

/** Idempotently ensure the private photo bucket exists. */
async function ensurePhotoBucket(): Promise<void> {
  const storage = db().storage;
  const { data } = await storage.getBucket(PHOTO_BUCKET);
  if (data) return;
  const { error } = await storage.createBucket(PHOTO_BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`ensurePhotoBucket failed: ${error.message}`);
  }
}

/**
 * Upload EXIF-stripped photo bytes (and, only on retain_original opt-in, the
 * untouched original) to Supabase Storage, then pin a media_assets reference
 * row to the Moment. Three-tier model per THOUG-132.
 */
export async function uploadAndPinPhoto(args: {
  momentId: string;
  strippedJpeg: Buffer;
  original?: Buffer | null;
  retainOriginal: boolean;
  caption?: string | null;
}): Promise<{ assetId: string; storagePath: string }> {
  await ensurePhotoBucket();
  const storage = db().storage.from(PHOTO_BUCKET);
  const base = `${args.momentId}/${Date.now()}`;
  const derivativePath = `${base}/photo.jpg`;

  const up = await storage.upload(derivativePath, args.strippedJpeg, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (up.error) throw new Error(`photo upload failed: ${up.error.message}`);

  if (args.retainOriginal && args.original) {
    const orig = await storage.upload(`${base}/original.jpg`, args.original, {
      contentType: 'image/jpeg',
      upsert: false,
    });
    if (orig.error) throw new Error(`original upload failed: ${orig.error.message}`);
  }

  const { data, error } = await db()
    .from('media_assets')
    .insert({
      moment_id: args.momentId,
      asset_type: 'photo',
      storage_url: `${PHOTO_BUCKET}/${derivativePath}`,
      caption: args.caption ?? null,
      retain_original: args.retainOriginal,
    })
    .select('asset_id')
    .single();
  if (error) throw new Error(`media_assets insert failed: ${error.message}`);
  return { assetId: data.asset_id as string, storagePath: `${PHOTO_BUCKET}/${derivativePath}` };
}

/** Set/replace the spoken-commentary caption on a pinned photo. */
export async function setAssetCaption(assetId: string, caption: string): Promise<void> {
  const { error } = await db().from('media_assets').update({ caption }).eq('asset_id', assetId);
  if (error) throw new Error(`setAssetCaption failed: ${error.message}`);
}
