import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_DOCS_URL,
  DEEPSEEK_RETRY,
  DeepSeekApiError,
  deepSeekRetryDelayMs,
  describeDeepSeekStatus,
  translateDeepSeekError,
} from "./deepseek-errors.js";

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

describe("translateDeepSeekError", () => {
  it("wraps a documented DeepSeek status into a DeepSeekApiError", () => {
    const out = translateDeepSeekError(apiError(402), "deepseek-chat");
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
    const e = translateDeepSeekError(orig, "deepseek-reasoner") as DeepSeekApiError;
    expect(e.cause).toBe(orig);
  });

  it("surfaces DeepSeek's own error.message as detail", () => {
    const e = translateDeepSeekError(
      apiError(422, { detail: "max_tokens too large" }),
      "deepseek-chat",
    ) as DeepSeekApiError;
    expect(e.message).toContain("max_tokens too large");
  });

  it("captures retry-after on retryable errors", () => {
    const e = translateDeepSeekError(
      apiError(429, { retryAfter: "7" }),
      "deepseek-chat",
    ) as DeepSeekApiError;
    expect(e.retryAfterSeconds).toBe(7);
    expect(e.message).toContain("~7s");
  });

  it("ignores retry-after on non-retryable errors", () => {
    const e = translateDeepSeekError(
      apiError(400, { retryAfter: "7" }),
      "deepseek-chat",
    ) as DeepSeekApiError;
    expect(e.retryAfterSeconds).toBeUndefined();
  });

  it("passes non-DeepSeek models straight through", () => {
    const orig = apiError(402);
    expect(translateDeepSeekError(orig, "claude-sonnet-4-5")).toBe(orig);
  });

  it("passes status-less errors (abort/connection) straight through", () => {
    const abort = Object.assign(new Error("aborted"), { status: undefined });
    expect(translateDeepSeekError(abort, "deepseek-chat")).toBe(abort);
  });

  it("passes undocumented statuses straight through", () => {
    const orig = apiError(404);
    expect(translateDeepSeekError(orig, "deepseek-chat")).toBe(orig);
  });

  it("is idempotent — never double-wraps", () => {
    const once = translateDeepSeekError(apiError(503), "deepseek-chat");
    expect(translateDeepSeekError(once, "deepseek-chat")).toBe(once);
  });
});

describe("deepSeekRetryDelayMs", () => {
  it("backs off exponentially from the base delay", () => {
    expect(deepSeekRetryDelayMs(1)).toBe(DEEPSEEK_RETRY.baseDelayMs);
    expect(deepSeekRetryDelayMs(2)).toBe(DEEPSEEK_RETRY.baseDelayMs * 2);
    expect(deepSeekRetryDelayMs(3)).toBe(DEEPSEEK_RETRY.baseDelayMs * 4);
  });
  it("clamps to the max delay", () => {
    expect(deepSeekRetryDelayMs(100)).toBe(DEEPSEEK_RETRY.maxDelayMs);
  });
  it("honors retry-after over exponential backoff", () => {
    expect(deepSeekRetryDelayMs(1, 5)).toBe(5_000);
  });
  it("clamps a huge retry-after to the max delay", () => {
    expect(deepSeekRetryDelayMs(1, 9_999)).toBe(DEEPSEEK_RETRY.maxDelayMs);
  });
});
