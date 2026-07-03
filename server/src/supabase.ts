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
  // Next-session recap (v0.3): if the subscriber already has committed Moments
  // from a prior session, open this one with Seth's brief recap of them.
  const prior = await db()
    .from('rot_moments')
    .select('moment_id', { count: 'exact', head: true })
    .eq('subscriber_id', OWNER_SUBSCRIBER_ID)
    .eq('source', 'first_thread_voice')
    .eq('status', 'committed');
  if ((prior.count ?? 0) > 0) snapshot.nextSessionRecapPending = true;
  // Photo Walk (AC8/D5): a declined chapter photo ask persists across
  // sessions — carry the declined set forward from the most recent session.
  const last = await db()
    .from('rot_capture_sessions')
    .select('state_snapshot')
    .eq('subscriber_id', OWNER_SUBSCRIBER_ID)
    .eq('entry_point', 'first_thread')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last.data?.state_snapshot) {
    snapshot.photoDeclinedChapters = reviveSnapshot(last.data.state_snapshot).photoDeclinedChapters;
  }
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
): Promise<{ subscriberId: string; snapshot: SessionStateSnapshot; recapLastAt: string | null } | null> {
  const { data, error } = await db()
    .from('rot_capture_sessions')
    .select('subscriber_id, state_snapshot, recap_last_at')
    .eq('session_id', sessionId)
    .single();
  if (error || !data) return null;
  return {
    subscriberId: data.subscriber_id as string,
    snapshot: reviveSnapshot(data.state_snapshot),
    recapLastAt: (data.recap_last_at as string | null) ?? null,
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
  const { storageUrl } = await uploadPhotoBytes({
    key: `${args.momentId}/${Date.now()}`,
    strippedJpeg: args.strippedJpeg,
    original: args.original,
    retainOriginal: args.retainOriginal,
  });
  const { assetId } = await insertMediaAsset({
    momentId: args.momentId,
    storageUrl,
    retainOriginal: args.retainOriginal,
    caption: args.caption ?? null,
  });
  return { assetId, storagePath: storageUrl };
}

/**
 * Upload the EXIF-stripped derivative (and the original on opt-in) to Storage
 * under `key`, WITHOUT writing a media_assets row. Used both by uploadAndPinPhoto
 * and by the "held photo" path (photo shared before any Moment), where no
 * moment_id exists yet to satisfy the NOT NULL media_assets.moment_id.
 */
export async function uploadPhotoBytes(args: {
  key: string;
  strippedJpeg: Buffer;
  original?: Buffer | null;
  retainOriginal: boolean;
}): Promise<{ storageUrl: string }> {
  await ensurePhotoBucket();
  const storage = db().storage.from(PHOTO_BUCKET);
  const derivativePath = `${args.key}/photo.jpg`;

  const up = await storage.upload(derivativePath, args.strippedJpeg, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (up.error) throw new Error(`photo upload failed: ${up.error.message}`);

  if (args.retainOriginal && args.original) {
    const orig = await storage.upload(`${args.key}/original.jpg`, args.original, {
      contentType: 'image/jpeg',
      upsert: false,
    });
    if (orig.error) throw new Error(`original upload failed: ${orig.error.message}`);
  }
  return { storageUrl: `${PHOTO_BUCKET}/${derivativePath}` };
}

/** Insert a media_assets row pinning an already-uploaded derivative to a Moment. */
export async function insertMediaAsset(args: {
  momentId: string;
  storageUrl: string;
  retainOriginal: boolean;
  caption?: string | null;
}): Promise<{ assetId: string }> {
  const { data, error } = await db()
    .from('media_assets')
    .insert({
      moment_id: args.momentId,
      asset_type: 'photo',
      storage_url: args.storageUrl,
      caption: args.caption ?? null,
      retain_original: args.retainOriginal,
    })
    .select('asset_id')
    .single();
  if (error) throw new Error(`media_assets insert failed: ${error.message}`);
  return { assetId: data.asset_id as string };
}

/** Set/replace the spoken-commentary caption on a pinned photo. */
export async function setAssetCaption(assetId: string, caption: string): Promise<void> {
  const { error } = await db().from('media_assets').update({ caption }).eq('asset_id', assetId);
  if (error) throw new Error(`setAssetCaption failed: ${error.message}`);
}

/** A photo shared during a session, with a short-lived signed URL for display. */
export interface SessionPhoto {
  assetId: string | null;
  url: string;
  caption: string | null;
  createdAt: string;
}

/**
 * Photos shared during a session, for the inline conversation-card display
 * (AC9). Pinned assets are scoped by the session's start time (media_assets
 * has no session column — single-owner prototype); photos still HELD in the
 * snapshot (shared before any Moment) are included from their Storage URLs.
 * The bucket is private, so each photo gets a short-lived signed URL.
 */
export async function listSessionPhotos(sessionId: string): Promise<SessionPhoto[]> {
  const { data: sessionRow, error: sErr } = await db()
    .from('rot_capture_sessions')
    .select('started_at, subscriber_id, state_snapshot')
    .eq('session_id', sessionId)
    .single();
  if (sErr || !sessionRow) return [];
  const snapshot = reviveSnapshot(sessionRow.state_snapshot);

  const { data: assets } = await db()
    .from('media_assets')
    .select('asset_id, storage_url, caption, created_at, rot_moments!inner(subscriber_id)')
    .eq('asset_type', 'photo')
    .eq('rot_moments.subscriber_id', sessionRow.subscriber_id as string)
    .gte('created_at', sessionRow.started_at as string)
    .order('created_at', { ascending: true });

  const storage = db().storage;
  const sign = async (storageUrl: string): Promise<string | null> => {
    const slash = storageUrl.indexOf('/');
    if (slash <= 0) return null;
    const bucket = storageUrl.slice(0, slash);
    const path = storageUrl.slice(slash + 1);
    const { data } = await storage.from(bucket).createSignedUrl(path, 3600);
    return data?.signedUrl ?? null;
  };

  const out: SessionPhoto[] = [];
  for (const a of assets ?? []) {
    const url = await sign(a.storage_url as string);
    if (url) {
      out.push({
        assetId: a.asset_id as string,
        url,
        caption: (a.caption as string | null) ?? null,
        createdAt: a.created_at as string,
      });
    }
  }
  for (const held of snapshot.heldPhotos) {
    const url = await sign(held.storageUrl);
    if (url) out.push({ assetId: null, url, caption: null, createdAt: sessionRow.started_at as string });
  }
  return out;
}
