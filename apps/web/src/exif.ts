/**
 * Client-side EXIF handling (E13-05, v0.2 hardening).
 *
 * Privacy + injection safety: raw EXIF never leaves the device. We
 *   1. PARSE date + GPS here, in the browser, into plain validated text
 *      (proposed to the subscriber for spoken confirmation — never asserted),
 *   2. STRIP all metadata by re-encoding through a canvas (canvas output
 *      carries no EXIF/IPTC/XMP), and upload only the clean derivative.
 * The untouched original is uploaded ONLY on an explicit retain_original
 * opt-in. No third-party EXIF library — small, auditable TIFF walk.
 */

export interface ParsedExif {
  /** e.g. "June 1987" — derived from DateTimeOriginal, human-phrased. */
  whenText?: string;
  /** e.g. "45.52°N, 122.68°W" — coarse (2dp ≈ 1km), never precise. */
  whereText?: string;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parse DateTimeOriginal + GPS out of a JPEG's EXIF, defensively. */
export function parseExif(bytes: ArrayBuffer): ParsedExif {
  try {
    return parseExifInner(new DataView(bytes));
  } catch {
    return {};
  }
}

function parseExifInner(view: DataView): ParsedExif {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {}; // not a JPEG
  // Find the APP1 (EXIF) segment.
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    const size = view.getUint16(offset + 2);
    if (marker === 0xffe1) {
      // "Exif\0\0"
      if (view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0x0000) {
        return parseTiff(view, offset + 10);
      }
    }
    if ((marker & 0xff00) !== 0xff00) break;
    offset += 2 + size;
  }
  return {};
}

function parseTiff(view: DataView, tiffStart: number): ParsedExif {
  const little = view.getUint16(tiffStart) === 0x4949;
  const u16 = (o: number) => view.getUint16(tiffStart + o, little);
  const u32 = (o: number) => view.getUint32(tiffStart + o, little);

  const out: ParsedExif = {};
  let exifIfd = 0;
  let gpsIfd = 0;

  const ifd0 = u32(4);
  walkIfd(ifd0, (tag, valueOffset) => {
    if (tag === 0x8769) exifIfd = u32(valueOffset);
    if (tag === 0x8825) gpsIfd = u32(valueOffset);
  });

  if (exifIfd) {
    walkIfd(exifIfd, (tag, valueOffset, type, count) => {
      if (tag === 0x9003 && type === 2) {
        // DateTimeOriginal "YYYY:MM:DD HH:MM:SS"
        const strOff = count > 4 ? u32(valueOffset) : valueOffset - tiffStart;
        let s = '';
        for (let i = 0; i < Math.min(count, 20) - 1; i++) {
          s += String.fromCharCode(view.getUint8(tiffStart + strOff + i));
        }
        const m = /^(\d{4}):(\d{2}):/.exec(s);
        if (m) {
          const year = Number(m[1]);
          const month = Number(m[2]);
          if (year > 1820 && year < 2100 && month >= 1 && month <= 12) {
            out.whenText = `${MONTHS[month - 1]} ${year}`;
          }
        }
      }
    });
  }

  if (gpsIfd) {
    let latRef = 'N';
    let lonRef = 'E';
    let lat: number | null = null;
    let lon: number | null = null;
    const rational = (off: number) => u32(off) / (u32(off + 4) || 1);
    const dms = (valueOffset: number): number => {
      const off = u32(valueOffset);
      return rational(off) + rational(off + 8) / 60 + rational(off + 16) / 3600;
    };
    walkIfd(gpsIfd, (tag, valueOffset, type) => {
      if (tag === 0x0001) latRef = String.fromCharCode(view.getUint8(tiffStart + valueOffset - tiffStart + 0)) || 'N';
      if (tag === 0x0003) lonRef = String.fromCharCode(view.getUint8(tiffStart + valueOffset - tiffStart + 0)) || 'E';
      if (tag === 0x0002 && type === 5) lat = dms(valueOffset);
      if (tag === 0x0004 && type === 5) lon = dms(valueOffset);
    });
    if (lat !== null && lon !== null && isFinite(lat) && isFinite(lon)) {
      // Coarse on purpose: 2 decimal places (~1 km).
      out.whereText = `${(lat as number).toFixed(2)}°${latRef === 'S' ? 'S' : 'N'}, ${(lon as number).toFixed(2)}°${lonRef === 'W' ? 'W' : 'E'}`;
    }
  }
  return out;

  function walkIfd(
    ifdOffset: number,
    visit: (tag: number, valueOffset: number, type: number, count: number) => void,
  ): void {
    if (ifdOffset <= 0 || tiffStart + ifdOffset + 2 > view.byteLength) return;
    const entries = u16(ifdOffset);
    for (let i = 0; i < entries; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (tiffStart + entry + 12 > view.byteLength) return;
      visit(u16(entry), entry + 8, u16(entry + 2), u32(entry + 4));
    }
  }
}

/**
 * Strip ALL metadata by decoding to a canvas and re-encoding as JPEG.
 * Canvas output carries no EXIF/IPTC/XMP. Downscales very large captures so
 * the derivative stays a reasonable upload (max edge 2048px).
 */
export async function stripExif(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 2048;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('jpeg encode failed'))),
      'image/jpeg',
      0.88,
    );
  });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}
