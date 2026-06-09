import { afterEach, describe, expect, it, vi } from "vitest";

const REQUIRED = {
  ANTHROPIC_API_KEY: "sk-test",
  NOTION_TOKEN: "ntn-test",
  HUME_API_KEY: "hume-key",
  HUME_SECRET_KEY: "hume-secret",
  HUME_CONFIG_ID: "config-id",
  HUME_SETH_VOICE_ID: "voice-id",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  OPENAI_API_KEY: "sk-openai",
};

function stubAllRequired() {
  for (const [name, value] of Object.entries(REQUIRED)) {
    vi.stubEnv(name, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as { window?: unknown }).window;
});

describe("serverEnv", () => {
  it("loads all secrets and defaults ANTHROPIC_MODEL", async () => {
    stubAllRequired();
    vi.stubEnv("ANTHROPIC_MODEL", "");
    vi.resetModules();

    const { serverEnv } = await import("./env.ts");
    expect(serverEnv.anthropic.apiKey).toBe("sk-test");
    expect(serverEnv.anthropic.model).toBe("claude-sonnet-4-6");
    expect(serverEnv.supabase.serviceRoleKey).toBe("service-role");
    expect(serverEnv.flags.voiceSeth).toBeUndefined();
  });

  it("fails fast when a required secret is missing", async () => {
    stubAllRequired();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.resetModules();

    await expect(import("./env.ts")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("refuses to load in a browser-like environment", async () => {
    stubAllRequired();
    (globalThis as { window?: unknown }).window = {};
    vi.resetModules();

    await expect(import("./env.ts")).rejects.toThrow(/client code/);
  });
});
