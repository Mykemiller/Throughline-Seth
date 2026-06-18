/**
 * Lightweight client-side diagnostics log for the First Thread voice surface.
 *
 * Why client-side: the live photo bug is that nothing reaches the server (no
 * `POST /api/photos`), so server logs are silent. The interesting events —
 * which photo was selected, whether a Moment existed to pin to, whether an
 * upload was even attempted, and any error — all happen in the browser. This
 * captures them in an in-memory ring buffer that can be downloaded as a JSON
 * "application log file" to diagnose what went wrong.
 *
 * No PII beyond what the subscriber already typed: we log file names/sizes and
 * session/flow state, never image bytes or transcript content.
 */

export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagEvent {
  t: string; // ISO timestamp
  level: DiagLevel;
  event: string; // short, greppable key e.g. "photo.upload.error"
  data?: Record<string, unknown>;
}

const MAX_EVENTS = 500;
const buffer: DiagEvent[] = [];

/** Record a diagnostic event (also mirrored to the browser console). */
export function logDiag(level: DiagLevel, event: string, data?: Record<string, unknown>): void {
  const entry: DiagEvent = { t: new Date().toISOString(), level, event, data };
  buffer.push(entry);
  if (buffer.length > MAX_EVENTS) buffer.shift();
  const line = `[diag] ${event}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else console.info(line, data ?? '');
}

export const diag = {
  info: (event: string, data?: Record<string, unknown>) => logDiag('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => logDiag('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => logDiag('error', event, data),
};

/** The current build id, available everywhere for tagging logs. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** A snapshot of the log as a structured object (build id + events). */
export function getDiagLog(): { buildId: string; capturedAt: string; events: DiagEvent[] } {
  return { buildId: BUILD_ID, capturedAt: new Date().toISOString(), events: [...buffer] };
}

/** Trigger a browser download of the diagnostics log as a JSON file. */
export function downloadDiagLog(): void {
  const blob = new Blob([JSON.stringify(getDiagLog(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `throughline-diag-${BUILD_ID.replace(/[:]/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  diag.info('diag.downloaded', { events: buffer.length });
}
