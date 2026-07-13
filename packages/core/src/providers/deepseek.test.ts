import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_DOCS_URL,
  DeepSeekApiError,
  deepseekBalanceUrl,
  deepseekProfile,
  describeDeepSeekStatus,
  toDeepSeekApiError,
} from "./deepseek.js";

/** Mimic the shape of an Anthropic SDK APIError for a DeepSeek response. */
function apiError(
  status: number,
  opts: { detail?: string; retryAfter?: string } = {},
): Error & { status: number } {
  const headers = new Headers();
  if (opts.retryAfter !== undefined) headers.set("retry-after", opts.retryAfter);
  return Object.assign(new Error(`${status} boom`), {
    status,
    headers,
    ...(opts.detail
      ? { error: { error: { message: opts.detail, type: "x", code: "y" } } }
      : {}),
  });
}

describe("describeDeepSeekStatus", () => {
  it("maps the seven documented codes", () => {
    for (const s of [400, 401, 402, 422, 429, 500, 503]) {
      expect(describeDeepSeekStatus(s)?.status).toBe(s);
    }
  });
  it("marks only 429/500/503 retryable", () => {
    expect(describeDeepSeekStatus(429)?.retryable).toBe(true);
    expect(describeDeepSeekStatus(500)?.retryable).toBe(true);
    expect(describeDeepSeekStatus(503)?.retryable).toBe(true);
    expect(describeDeepSeekStatus(402)?.retryable).toBe(false);
    expect(describeDeepSeekStatus(401)?.retryable).toBe(false);
  });
  it("returns undefined for undocumented or missing status", () => {
    expect(describeDeepSeekStatus(404)).toBeUndefined();
    expect(describeDeepSeekStatus(undefined)).toBeUndefined();
  });
});

describe("toDeepSeekApiError", () => {
  it("wraps a documented DeepSeek status into a DeepSeekApiError", () => {
    const out = toDeepSeekApiError(apiError(402));
    expect(out).toBeInstanceOf(DeepSeekApiError);
    const e = out as DeepSeekApiError;
    expect(e.status).toBe(402);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("402");
    expect(e.message).toContain("Insufficient Balance");
    expect(e.message).toContain(DEEPSEEK_DOCS_URL);
    // top-up link is the actionable remedy for 402
    expect(e.message).toContain("platform.deepseek.com/top_up");
  });

  it("keeps the original SDK error as cause", () => {
    const orig = apiError(401);
    const e = toDeepSeekApiError(orig) as DeepSeekApiError;
    expect(e.cause).toBe(orig);
  });

  it("surfaces DeepSeek's own error.message as detail", () => {
    const e = toDeepSeekApiError(apiError(422, { detail: "max_tokens too large" })) as DeepSeekApiError;
    expect(e.message).toContain("max_tokens too large");
  });

  it("captures retry-after on retryable errors", () => {
    const e = toDeepSeekApiError(apiError(429, { retryAfter: "7" })) as DeepSeekApiError;
    expect(e.retryAfterSeconds).toBe(7);
    expect(e.message).toContain("~7s");
  });

  it("ignores retry-after on non-retryable errors", () => {
    const e = toDeepSeekApiError(apiError(400, { retryAfter: "7" })) as DeepSeekApiError;
    expect(e.retryAfterSeconds).toBeUndefined();
  });

  it("returns null for status-less errors (abort/connection)", () => {
    const abort = Object.assign(new Error("aborted"), { status: undefined });
    expect(toDeepSeekApiError(abort)).toBeNull();
  });

  it("returns null for undocumented statuses", () => {
    expect(toDeepSeekApiError(apiError(404))).toBeNull();
  });

  it("is idempotent — never double-wraps", () => {
    const once = toDeepSeekApiError(apiError(503));
    expect(toDeepSeekApiError(once)).toBe(once);
  });
});

describe("deepseekBalanceUrl", () => {
  it("returns the balance endpoint for the official DeepSeek host", () => {
    expect(deepseekBalanceUrl("https://api.deepseek.com/anthropic")).toBe(
      "https://api.deepseek.com/user/balance",
    );
    // The path on the configured base URL is irrelevant — balance lives at root.
    expect(deepseekBalanceUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/user/balance",
    );
  });

  it("returns null off DeepSeek's official host", () => {
    expect(deepseekBalanceUrl("https://api.anthropic.com")).toBeNull();
    expect(deepseekBalanceUrl("https://openrouter.ai/api")).toBeNull();
    expect(deepseekBalanceUrl(undefined)).toBeNull();
    expect(deepseekBalanceUrl("not a url")).toBeNull();
  });
});

describe("deepseekProfile.probeBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const probe = (overrides: { baseURL?: string; apiKey?: string }) => ({
    apiKey: "sk-test",
    ...overrides,
  });

  it("returns null when not on DeepSeek's official API (no fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await deepseekProfile.probeBalance!(probe({ baseURL: "https://api.anthropic.com" }))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when no api key is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(
      await deepseekProfile.probeBalance!({ baseURL: "https://api.deepseek.com/anthropic" }),
    ).toBeNull();
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
      await deepseekProfile.probeBalance!(probe({ baseURL: "https://api.deepseek.com/anthropic" })),
    ).toEqual({ currency: "CNY", total: 110, available: true });
  });

  it("sends a bearer token to the balance endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ is_available: true, balance_infos: [] }), { status: 200 }),
    );
    // Empty balance_infos -> null, but the request shape is what we assert.
    await deepseekProfile.probeBalance!(probe({ baseURL: "https://api.deepseek.com/anthropic" }));
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
      await deepseekProfile.probeBalance!(probe({ baseURL: "https://api.deepseek.com/anthropic" })),
    ).toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(
      await deepseekProfile.probeBalance!(probe({ baseURL: "https://api.deepseek.com/anthropic" })),
    ).toBeNull();
  });
});
