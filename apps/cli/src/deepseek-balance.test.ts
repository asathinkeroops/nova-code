import { describe, expect, it, vi, afterEach } from "vitest";
import { deepseekBalanceUrl, fetchDeepSeekBalance } from "./deepseek-balance.js";
import type { Settings } from "@nova/runtime";

function settings(overrides: Partial<Settings>): Settings {
  // Only the fields the balance helpers read matter here.
  return { apiKey: "sk-test", ...overrides } as Settings;
}

describe("deepseekBalanceUrl", () => {
  it("returns the balance endpoint for the official DeepSeek host", () => {
    expect(deepseekBalanceUrl(settings({ baseURL: "https://api.deepseek.com/anthropic" }))).toBe(
      "https://api.deepseek.com/user/balance",
    );
    // The path on the configured base URL is irrelevant — balance lives at root.
    expect(deepseekBalanceUrl(settings({ baseURL: "https://api.deepseek.com" }))).toBe(
      "https://api.deepseek.com/user/balance",
    );
  });

  it("returns null off DeepSeek's official host", () => {
    expect(deepseekBalanceUrl(settings({ baseURL: "https://api.anthropic.com" }))).toBeNull();
    expect(deepseekBalanceUrl(settings({ baseURL: "https://openrouter.ai/api" }))).toBeNull();
    expect(deepseekBalanceUrl(settings({ baseURL: undefined }))).toBeNull();
    expect(deepseekBalanceUrl(settings({ baseURL: "not a url" }))).toBeNull();
  });
});

describe("fetchDeepSeekBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when not on DeepSeek's official API (no fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await fetchDeepSeekBalance(settings({ baseURL: "https://api.anthropic.com" }))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when no api key is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const s = settings({ baseURL: "https://api.deepseek.com/anthropic" });
    s.apiKey = undefined;
    expect(await fetchDeepSeekBalance(s)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses the first balance entry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00" }],
        }),
        { status: 200 },
      ),
    );
    expect(
      await fetchDeepSeekBalance(settings({ baseURL: "https://api.deepseek.com/anthropic" })),
    ).toEqual({ currency: "CNY", total: 110, available: true });
  });

  it("sends a bearer token to the balance endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ is_available: true, balance_infos: [] }), { status: 200 }),
    );
    // Empty balance_infos -> null, but the request shape is what we assert.
    await fetchDeepSeekBalance(settings({ baseURL: "https://api.deepseek.com/anthropic" }));
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("returns null on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    expect(
      await fetchDeepSeekBalance(settings({ baseURL: "https://api.deepseek.com/anthropic" })),
    ).toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(
      await fetchDeepSeekBalance(settings({ baseURL: "https://api.deepseek.com/anthropic" })),
    ).toBeNull();
  });
});
