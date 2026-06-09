import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("clientEnv", () => {
  it("reads the Supabase URL and anon key from VITE_* vars", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-123");
    vi.resetModules();

    const { clientEnv } = await import("./env");
    expect(clientEnv.supabase.url).toBe("https://example.supabase.co");
    expect(clientEnv.supabase.anonKey).toBe("anon-key-123");
  });

  it("fails fast when a required client var is missing", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-123");
    vi.resetModules();

    await expect(import("./env")).rejects.toThrow(/VITE_SUPABASE_URL/);
  });
});
