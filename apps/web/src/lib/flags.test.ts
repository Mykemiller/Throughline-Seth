import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("flags", () => {
  it("first_thread_voice is off by default when unset", async () => {
    vi.stubEnv("VITE_FEATURE_FIRST_THREAD_VOICE", "");
    vi.resetModules();
    const { flags } = await import("./flags");
    expect(flags.firstThreadVoice).toBe(false);
  });

  it("only the exact string 'true' enables a flag", async () => {
    vi.stubEnv("VITE_FEATURE_FIRST_THREAD_VOICE", "1");
    vi.resetModules();
    const off = (await import("./flags")).flags;
    expect(off.firstThreadVoice).toBe(false);

    vi.stubEnv("VITE_FEATURE_FIRST_THREAD_VOICE", "true");
    vi.resetModules();
    const on = (await import("./flags")).flags;
    expect(on.firstThreadVoice).toBe(true);
  });
});
