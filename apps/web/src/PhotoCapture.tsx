/**
 * Mid-interview photo capture (E13-05/06). Take or choose a photograph; EXIF
 * is parsed AND stripped on-device (see exif.ts); only the clean derivative
 * (plus validated text metadata) is uploaded — the original only on explicit
 * retain opt-in. The photo pins to the active Moment and Seth invites spoken
 * commentary on his next turn.
 *
 * The picker is always available while connected: you can choose one photo or
 * several at once. A photo can only be *pinned* to a Moment, so if none is
 * confirmed yet we hold the prepared photos and attach them automatically the
 * moment one is placed on the River — the button is never a dead end. A batch
 * uploads sequentially; the server queues them so Seth takes them one at a time.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadPhoto } from './api';
import { diag } from './diagnostics';
import { blobToBase64, parseExif, stripExif } from './exif';

type PreparedPhoto = Parameters<typeof uploadPhoto>[0];

export function PhotoCapture({
  sessionId,
  hasActiveMoment,
  onPinned,
}: {
  sessionId: string;
  hasActiveMoment: boolean;
  onPinned: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [retainOriginal, setRetainOriginal] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Prepared (EXIF-stripped) photos waiting for a Moment to pin to — a batch
  // selected before any Moment exists is held here and drained in order.
  const [pending, setPending] = useState<PreparedPhoto[]>([]);
  // Local preview of the most recent selected (EXIF-stripped) photo.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const uploadingRef = useRef(false);

  // Revoke the object URL when it changes or the component unmounts.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Upload a batch sequentially so the server queues them one at a time.
  const uploadAll = useCallback(
    async (payloads: PreparedPhoto[]) => {
      if (uploadingRef.current || payloads.length === 0) return;
      uploadingRef.current = true;
      setBusy(true);
      diag.info('photo.upload.start', { count: payloads.length, sessionId });
      try {
        for (const payload of payloads) {
          const result = await uploadPhoto(payload);
          diag.info('photo.upload.ok', {
            assetId: result.assetId,
            momentId: result.momentId,
            whenText: payload.whenText,
          });
        }
        setPending([]);
        setNote(
          payloads.length > 1
            ? `${payloads.length} photographs placed — Seth will take them one at a time.`
            : 'Photograph placed with this Moment — tell Seth about it.',
        );
        onPinned();
      } catch (e) {
        diag.error('photo.upload.error', { message: (e as Error).message });
        setNote(`Couldn’t add the photograph: ${(e as Error).message}`);
      } finally {
        setBusy(false);
        uploadingRef.current = false;
      }
    },
    [onPinned],
  );

  // When a Moment becomes available, attach any photos that were waiting.
  useEffect(() => {
    if (pending.length > 0 && hasActiveMoment && !uploadingRef.current) {
      void uploadAll(pending);
    }
  }, [pending, hasActiveMoment, uploadAll]);

  const onFiles = async (fileList: FileList | null) => {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0 || busy) return;
    setBusy(true);
    setNote(null);
    diag.info('photo.selected', {
      count: files.length,
      names: files.map((f) => f.name),
      sizes: files.map((f) => f.size),
      hasActiveMoment,
      retainOriginal,
    });
    try {
      const payloads: PreparedPhoto[] = [];
      let lastStripped: Blob | null = null;
      for (const file of files) {
        const bytes = await file.arrayBuffer();
        const exif = parseExif(bytes);
        const stripped = await stripExif(file);
        lastStripped = stripped;
        const payload: PreparedPhoto = {
          sessionId,
          strippedBase64: await blobToBase64(stripped),
          retainOriginal,
          whenText: exif.whenText,
          whereText: exif.whereText,
        };
        if (retainOriginal) payload.originalBase64 = await blobToBase64(file);
        payloads.push(payload);
        diag.info('photo.prepared', {
          name: file.name,
          originalBytes: file.size,
          strippedBytes: stripped.size,
          whenText: exif.whenText ?? null,
          whereText: exif.whereText ?? null,
        });
      }
      // Show the cleaned derivative of the last selected photo straight away.
      if (lastStripped) {
        const blob = lastStripped;
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      }

      if (hasActiveMoment) {
        await uploadAll(payloads);
      } else {
        // No Moment yet — hold them; the effect attaches once one is placed.
        // This is the common "photo never reaches the server" cause: a photo
        // shared before any Moment exists (e.g. during the Introduction) sits
        // here until the conversation produces one.
        diag.warn('photo.held.no_active_moment', {
          count: payloads.length,
          note: 'upload deferred until a Moment is placed; no POST /api/photos yet',
        });
        setPending(payloads);
        setNote(
          payloads.length > 1
            ? `${payloads.length} photographs ready — they’ll attach as soon as you and Seth place a Moment.`
            : 'Photograph ready — it will attach as soon as you and Seth place a Moment.',
        );
      }
    } catch (e) {
      diag.error('photo.prepare.error', { message: (e as Error).message });
      setNote(`Couldn’t prepare the photograph: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const label = busy
    ? pending.length > 0
      ? 'Placing…'
      : 'Preparing…'
    : pending.length > 0
      ? pending.length > 1
        ? `${pending.length} photographs ready`
        : 'Photograph ready'
      : 'Add a photograph';

  return (
    <div className="ft-photo">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />
      <button
        className="ft-btn"
        type="button"
        disabled={busy}
        title="Choose or take a photograph"
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </button>
      <label className="ft-photo__retain">
        <input
          type="checkbox"
          checked={retainOriginal}
          onChange={(e) => setRetainOriginal(e.target.checked)}
        />
        Keep my original file too
      </label>
      {previewUrl && (
        <figure className="ft-photo__preview">
          <img className="ft-photo__preview-img" src={previewUrl} alt="The photograph you just chose" />
        </figure>
      )}
      {!hasActiveMoment && pending.length === 0 && !note && (
        <p className="ft-photo__note">
          You can add a photograph anytime — it attaches to a Moment once you’ve placed one with Seth.
        </p>
      )}
      {note && <p className="ft-photo__note">{note}</p>}
    </div>
  );
}
