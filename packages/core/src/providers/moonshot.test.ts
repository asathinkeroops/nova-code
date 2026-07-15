import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./error.js";
import {
  MOONSHOT_DOCS_URL,
  describeMoonshotStatus,
  moonshotBalanceUrl,
  moonshotProfile,
  translateMoonshotError,
} from "./moonshot.js";

/** Mimic the shape of an Anthropic SDK APIError for a Moonshot response. */
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

describe("describeMoonshotStatus", () => {
  it("maps the documented codes", () => {
    for (const s of [400, 401, 403, 429, 500, 503]) {
      expect(describeMoonshotStatus(s)?.status).toBe(s);
    }
  });
  it("marks only 429/500/503 retryable", () => {
    expect(describeMoonshotStatus(429)?.retryable).toBe(true);
    expect(describeMoonshotStatus(500)?.retryable).toBe(true);
    expect(describeMoonshotStatus(503)?.retryable).toBe(true);
    expect(describeMoonshotStatus(400)?.retryable).toBe(false);
    expect(describeMoonshotStatus(401)?.retryable).toBe(false);
    expect(describeMoonshotStatus(403)?.retryable).toBe(false);
  });
  it("returns undefined for undocumented or missing status", () => {
    expect(describeMoonshotStatus(404)).toBeUndefined();
    expect(describeMoonshotStatus(undefined)).toBeUndefined();
  });
});

describe("translateMoonshotError", () => {
  it("wraps a documented Moonshot status into a ProviderError", () => {
    const out = translateMoonshotError(apiError(401));
    expect(out).toBeInstanceOf(ProviderError);
    const e = out as ProviderError;
    expect(e.provider).toBe("moonshot");
    expect(e.status).toBe(401);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("401");
    expect(e.message).toContain("Authentication Failure");
    expect(e.message).toContain(MOONSHOT_DOCS_URL);
    expect(e.message).toContain("platform.moonshot.cn/console/api-keys");
  });

  it("keeps the original SDK error as cause", () => {
    const orig = apiError(400);
    const e = translateMoonshotError(orig) as ProviderError;
    expect(e.cause).toBe(orig);
  });

  it("surfaces Moonshot's own error.message as detail", () => {
    const e = translateMoonshotError(apiError(400, { detail: "bad thinking.keep" })) as ProviderError;
    expect(e.message).toContain("bad thinking.keep");
  });

  it("captures retry-after on retryable errors", () => {
    const e = translateMoonshotError(apiError(429, { retryAfter: "5" })) as ProviderError;
    expect(e.retryAfterSeconds).toBe(5);
    expect(e.message).toContain("~5s");
  });

  it("ignores retry-after on non-retryable errors", () => {
    const e = translateMoonshotError(apiError(400, { retryAfter: "5" })) as ProviderError;
    expect(e.retryAfterSeconds).toBeUndefined();
  });

  it("returns null for status-less errors (abort/connection)", () => {
    const abort = Object.assign(new Error("aborted"), { status: undefined });
    expect(translateMoonshotError(abort)).toBeNull();
  });

  it("returns null for undocumented statuses", () => {
    expect(translateMoonshotError(apiError(404))).toBeNull();
  });

  it("is idempotent — never double-wraps", () => {
    const once = translateMoonshotError(apiError(503));
    expect(translateMoonshotError(once)).toBe(once);
  });
});

describe("moonshotProfile.onError", () => {
  it("retries a transient status with backoff and carries the translated error", () => {
    const d = moonshotProfile.onError(apiError(503), 1);
    expect(d).toMatchObject({ retry: true, delayMs: 1_000 });
    expect((d as { error: unknown }).error).toBeInstanceOf(ProviderError);
    expect(((d as { error: ProviderError }).error).status).toBe(503);
  });
  it("does not retry a non-retryable status, surfaces the translated error", () => {
    const d = moonshotProfile.onError(apiError(403), 1);
    expect(d.retry).toBe(false);
    expect(d.error).toBeInstanceOf(ProviderError);
    expect((d.error as ProviderError).status).toBe(403);
  });
  it("passes an undocumented/status-less error through untranslated", () => {
    const raw = new Error("socket hang up");
    expect(moonshotProfile.onError(raw, 1)).toEqual({ retry: false, error: raw });
  });
});

describe("moonshotBalanceUrl", () => {
  it("returns the balance endpoint for the official Moonshot host", () => {
    expect(moonshotBalanceUrl("https://api.moonshot.cn/anthropic")).toBe(
      "https://api.moonshot.cn/v1/users/me/balance",
    );
    // The path on the configured base URL is irrelevant — balance lives at root.
    expect(moonshotBalanceUrl("https://api.moonshot.cn")).toBe(
      "https://api.moonshot.cn/v1/users/me/balance",
    );
  });

  it("returns null off Moonshot's official host", () => {
    expect(moonshotBalanceUrl("https://api.moonshot.ai/anthropic")).toBeNull();
    expect(moonshotBalanceUrl("https://api.deepseek.com")).toBeNull();
    expect(moonshotBalanceUrl(undefined)).toBeNull();
    expect(moonshotBalanceUrl("not a url")).toBeNull();
  });
});

describe("moonshotProfile.probeBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const probe = (overrides: { baseURL?: string; apiKey?: string }) => ({
    apiKey: "sk-test",
    ...overrides,
  });

  it("returns null when not on Moonshot's official API (no fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(
      await moonshotProfile.probeBalance!(probe({ baseURL: "https://api.moonshot.ai/anthropic" })),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when no api key is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(
      await moonshotProfile.probeBalance!({ baseURL: "https://api.moonshot.cn/anthropic" }),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses available_balance as a CNY total", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3.0 },
          status: true,
        }),
        { status: 200 },
      ),
    );
    expect(
      await moonshotProfile.probeBalance!(probe({ baseURL: "https://api.moonshot.cn/anthropic" })),
    ).toEqual({ currency: "CNY", total: 49.58, available: true });
  });

  it("reports unavailable when the balance is non-positive", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: { available_balance: 0 } }), {
        status: 200,
      }),
    );
    expect(
      await moonshotProfile.probeBalance!(probe({ baseURL: "https://api.moonshot.cn/anthropic" })),
    ).toEqual({ currency: "CNY", total: 0, available: false });
  });

  it("sends a bearer token to the balance endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: { available_balance: 1 } }), {
        status: 200,
      }),
    );
    await moonshotProfile.probeBalance!(probe({ baseURL: "https://api.moonshot.cn/anthropic" }));
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.moonshot.cn/v1/users/me/balance",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("returns null on a malformed body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: {} }), { status: 200 }),
    );
    expect(
      await moonshotProfile.probeBalance!(probe({ baseURL: "https://api.moonshot.cn/anthropic" })),
    ).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    expect(
      await moonshotProfile.probeBalance!(probe({ baseURL: "https://api.moonshot.cn/anthropic" })),
    ).toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(
      await moonshotProfile.probeBalance!(probe({ baseURL: "https://api.moonshot.cn/anthropic" })),
    ).toBeNull();
  });
});
