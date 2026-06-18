import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Build stamp, computed once at build time and frozen into the bundle:
 *   "{day-of-year}-{year}:{seconds-past-midnight}"  (UTC)
 * e.g. "169-2026:48273". Day-of-year + year identifies the build day; the
 * seconds-past-midnight make each rebuild within a day unique. Shown bottom-left
 * on the home page so you can tell at a glance which build is live.
 */
function computeBuildId(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const startOfYear = Date.UTC(year, 0, 1);
  const today = Date.UTC(year, now.getUTCMonth(), now.getUTCDate());
  const dayOfYear = Math.floor((today - startOfYear) / 86_400_000) + 1;
  const secondsPastMidnight =
    now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  return `${dayOfYear}-${year}:${secondsPastMidnight}`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const serverOrigin = env.VITE_SERVER_ORIGIN || 'http://localhost:8787';
  return {
    plugins: [react()],
    define: {
      __BUILD_ID__: JSON.stringify(computeBuildId()),
    },
    resolve: {
      alias: {
        // Resolve the workspace package to its TypeScript source so Vite
        // transpiles it (the package's main is a .ts entry).
        '@throughline/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
    },
    server: {
      // Allow importing tokens.css and shared sources from the repo root.
      fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
      proxy: {
        '/api': { target: serverOrigin, changeOrigin: true },
      },
    },
  };
});
