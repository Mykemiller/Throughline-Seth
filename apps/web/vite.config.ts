import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite loads .env from the repo root and inlines VITE_* vars into the client
// bundle. Server-only secrets live in apps/web/server/env.ts and never reach here.
export default defineConfig({
  plugins: [react()],
  envDir: "../../",
  server: {
    // Allow importing the canonical brand tokens from the repo root (tokens.css).
    fs: { allow: ["../../"] },
  },
});
