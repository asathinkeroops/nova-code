import { describe, expect, it } from "vitest";
import { DeepSeekApiError } from "./deepseek.js";
import { deepseekProfile } from "./deepseek.js";
import { PROVIDERS, resolveProfile } from "./index.js";
import { otherProfile } from "./other.js";

function apiError(status: number): Error & { status: number } {
  return Object.assign(new Error(`${status} boom`), { status, headers: new Headers() });
}

describe("resolveProfile", () => {
  it("maps a provider id to its profile", () => {
    expect(resolveProfile("deepseek")).toBe(deepseekProfile);
    expect(resolveProfile("other")).toBe(otherProfile);
  });

  it("registers both built-in profiles under their id", () => {
    expect(PROVIDERS.deepseek).toBe(deepseekProfile);
    expect(PROVIDERS.other).toBe(otherProfile);
  });
});

describe("deepseekProfile.thinking", () => {
  it("disables thinking at budget 0", () => {
    expect(deepseekProfile.thinking(0)).toEqual({ params: { thinking: { type: "disabled" } } });
  });
  it("uses effort:high below the max budget, no max_tokens floor", () => {
    expect(deepseekProfile.thinking(16_000)).toEqual({
      params: { thinking: { type: "enabled" }, output_config: { effort: "high" } },
    });
  });
  it("rounds to effort:max at/above the max budget", () => {
    expect(deepseekProfile.thinking(32_000).params).toEqual({
      thinking: { type: "enabled" },
      output_config: { effort: "max" },
    });
  });
});

describe("deepseekProfile.onError", () => {
  it("retries a transient status with backoff and carries the translated error", () => {
    const d = deepseekProfile.onError(apiError(503), 1);
    expect(d.retry).toBe(true);
    expect(d).toMatchObject({ retry: true, delayMs: 1_000, status: 503 });
    expect((d as { error: unknown }).error).toBeInstanceOf(DeepSeekApiError);
  });
  it("does not retry a non-retryable status, surfaces the translated error", () => {
    const d = deepseekProfile.onError(apiError(402), 1);
    expect(d.retry).toBe(false);
    expect(d.error).toBeInstanceOf(DeepSeekApiError);
    expect((d.error as DeepSeekApiError).status).toBe(402);
  });
  it("passes an undocumented/status-less error through untranslated", () => {
    const raw = new Error("socket hang up");
    expect(deepseekProfile.onError(raw, 1)).toEqual({ retry: false, error: raw });
  });
});

describe("otherProfile", () => {
  it("uses budget_tokens and imposes a max_tokens floor", () => {
    expect(otherProfile.thinking(16_000)).toEqual({
      params: { thinking: { type: "enabled", budget_tokens: 16_000 } },
      minMaxTokens: 16_000 + 8192,
    });
  });
  it("disables thinking at budget 0", () => {
    expect(otherProfile.thinking(0)).toEqual({ params: { thinking: { type: "disabled" } } });
  });
  it("never retries and passes the error through untouched", () => {
    const err = apiError(429);
    expect(otherProfile.onError(err, 1)).toEqual({ retry: false, error: err });
  });
});
