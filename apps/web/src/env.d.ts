/// <reference types="vite/client" />

/**
 * Build stamp injected at build time by Vite's `define` (see vite.config.ts).
 * Format: "{day-of-year}-{year}:{seconds-past-midnight}" in UTC.
 */
declare const __BUILD_ID__: string;
