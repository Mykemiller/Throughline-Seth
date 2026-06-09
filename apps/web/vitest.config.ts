import { defineConfig } from "vitest/config";

// Vitest loads env from the repo root (matching the app). Tests stub env
// explicitly via vi.stubEnv so they don't depend on the real .env.
export default defineConfig({
  envDir: "../../",
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
  },
});
