/**
 * Mid-interview photo capture (E13-05/06). Take or choose a photograph; EXIF
 * is parsed AND stripped on-device (see exif.ts); only the clean derivative
 * (plus validated text metadata) is uploaded — the original only on explicit
 * retain opt-in. On success the photo is pinned to the active Moment and Seth
 * invites spoken commentary on his next turn.
 */
import { useRef, useState } from 'react';
import { uploadPhoto } from './api';
import { blobToBase64, parseExif, stripExif } from './exif';

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

  const onFile = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const bytes = await file.arrayBuffer();
      const exif = parseExif(bytes);
      const stripped = await stripExif(file);
      const payload: Parameters<typeof uploadPhoto>[0] = {
        sessionId,
        strippedBase64: await blobToBase64(stripped),
        retainOriginal,
        whenText: exif.whenText,
        whereText: exif.whereText,
      };
      if (retainOriginal) payload.originalBase64 = await blobToBase64(file);
      await uploadPhoto(payload);
      setNote('Photograph placed with this Moment — tell Seth about it.');
      onPinned();
    } catch (e) {
      setNote(`Couldn’t add the photograph: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="ft-photo">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <button
        className="ft-btn"
        disabled={busy || !hasActiveMoment}
        title={hasActiveMoment ? 'Add a photograph to this Moment' : 'Confirm a Moment with Seth first'}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Adding…' : 'Add a photograph'}
      </button>
      <label className="ft-photo__retain">
        <input
          type="checkbox"
          checked={retainOriginal}
          onChange={(e) => setRetainOriginal(e.target.checked)}
        />
        Keep my original file too
      </label>
      {note && <p className="ft-photo__note">{note}</p>}
    </div>
  );
}
