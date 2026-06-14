/**
 * Mid-interview photo capture (E13-05/06). Take or choose a photograph; EXIF
 * is parsed AND stripped on-device (see exif.ts); only the clean derivative
 * (plus validated text metadata) is uploaded — the original only on explicit
 * retain opt-in. The photo pins to the active Moment and Seth invites spoken
 * commentary on his next turn.
 *
 * The picker is always available while connected: you can choose a photo at any
 * time. A photo can only be *pinned* to a Moment, so if none is confirmed yet
 * we hold the prepared photo and attach it automatically the moment one is
 * placed on the River — the button is never a dead end.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadPhoto } from './api';
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
  // A prepared (EXIF-stripped) photo waiting for a Moment to pin to.
  const [pending, setPending] = useState<PreparedPhoto | null>(null);
  // Local preview of the selected (EXIF-stripped) photo — never the raw original.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const uploadingRef = useRef(false);

  // Revoke the object URL when it changes or the component unmounts.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const doUpload = useCallback(
    async (payload: PreparedPhoto) => {
      if (uploadingRef.current) return;
      uploadingRef.current = true;
      setBusy(true);
      try {
        await uploadPhoto(payload);
        setPending(null);
        setNote('Photograph placed with this Moment — tell Seth about it.');
        onPinned();
      } catch (e) {
        setNote(`Couldn’t add the photograph: ${(e as Error).message}`);
      } finally {
        setBusy(false);
        uploadingRef.current = false;
      }
    },
    [onPinned],
  );

  // When a Moment becomes available, attach any photo that was waiting.
  useEffect(() => {
    if (pending && hasActiveMoment && !uploadingRef.current) {
      void doUpload(pending);
    }
  }, [pending, hasActiveMoment, doUpload]);

  const onFile = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const bytes = await file.arrayBuffer();
      const exif = parseExif(bytes);
      const stripped = await stripExif(file);
      // Show the cleaned derivative back to the subscriber straight away.
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(stripped);
      });
      const payload: PreparedPhoto = {
        sessionId,
        strippedBase64: await blobToBase64(stripped),
        retainOriginal,
        whenText: exif.whenText,
        whereText: exif.whereText,
      };
      if (retainOriginal) payload.originalBase64 = await blobToBase64(file);

      if (hasActiveMoment) {
        await doUpload(payload);
      } else {
        // No Moment yet — hold it; the effect attaches it once one is placed.
        setPending(payload);
        setNote('Photograph ready — it will attach as soon as you and Seth place a Moment.');
      }
    } catch (e) {
      setNote(`Couldn’t prepare the photograph: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const label = busy
    ? pending
      ? 'Placing…'
      : 'Preparing…'
    : pending
      ? 'Photograph ready'
      : 'Add a photograph';

  return (
    <div className="ft-photo">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void onFile(e.target.files?.[0])}
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
      {!hasActiveMoment && !pending && !note && (
        <p className="ft-photo__note">
          You can add a photograph anytime — it attaches to a Moment once you’ve placed one with Seth.
        </p>
      )}
      {note && <p className="ft-photo__note">{note}</p>}
    </div>
  );
}
