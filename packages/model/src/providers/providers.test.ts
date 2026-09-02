import { describe, expect, it } from "vitest";
import { deepseekProfile } from "./deepseek.js";
import { ProviderError } from "./error.js";
import { isProviderId, PROVIDER_IDS, PROVIDERS, resolveProfile } from "./index.js";
import { moonshotProfile } from "./moonshot.js";
import { otherProfile } from "./other.js";

function apiError(status: number): Error & { status: number } {
  return Object.assign(new Error(`${status} boom`), { status, headers: new Headers() });
}

describe("resolveProfile", () => {
  it("maps a provider id to its profile", () => {
    expect(resolveProfile("deepseek")).toBe(deepseekProfile);
    expect(resolveProfile("moonshot")).toBe(moonshotProfile);
    expect(resolveProfile("other")).toBe(otherProfile);
  });

  it("registers the built-in profiles under their id", () => {
    expect(PROVIDERS.deepseek).toBe(deepseekProfile);
    expect(PROVIDERS.moonshot).toBe(moonshotProfile);
    expect(PROVIDERS.other).toBe(otherProfile);
  });

  it("falls back to the `other` profile for an unknown id", () => {
    // A provider entry's `profile` is a free-form string, so a typo or a generic
    // provider named directly resolves to the generic fallback, never throws.
    expect(resolveProfile("deepsek")).toBe(otherProfile);
    expect(resolveProfile("some-third-party")).toBe(otherProfile);
  });
});

describe("provider id helpers", () => {
  it("PROVIDER_IDS lists exactly the registry keys", () => {
    expect([...PROVIDER_IDS].sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  it("isProviderId narrows built-in ids and rejects the rest", () => {
    expect(isProviderId("deepseek")).toBe(true);
    expect(isProviderId("other")).toBe(true);
    expect(isProviderId("deepsek")).toBe(false);
    expect(isProviderId("")).toBe(false);
  });

  it("every built-in profile carries a positive tokenEstimate", () => {
    for (const profile of Object.values(PROVIDERS)) {
      expect(profile.tokenEstimate.cjk).toBeGreaterThan(0);
      expect(profile.tokenEstimate.other).toBeGreaterThan(0);
    }
  });

  it("profiles predate the transport field and default to anthropic", () => {
    expect(deepseekProfile.transport).toBeUndefined();
    expect(moonshotProfile.transport).toBeUndefined();
    expect(otherProfile.transport).toBeUndefined();
  });
});

describe("deepseekProfile.thinking", () => {
  it("disables thinking at budget 0", () => {
    expect(deepseekProfile.thinking(0, undefined, "anthropic")).toEqual({ params: { thinking: { type: "disabled" } } });
  });
  it("uses effort:high below the max budget, no max_tokens floor", () => {
    expect(deepseekProfile.thinking(16_000, undefined, "anthropic")).toEqual({
      params: { thinking: { type: "enabled" }, output_config: { effort: "high" } },
    });
  });
  it("rounds to effort:max at/above the max budget", () => {
    expect(deepseekProfile.thinking(32_000, undefined, "anthropic").params).toEqual({
      thinking: { type: "enabled" },
      output_config: { effort: "max" },
    });
  });
});

describe("deepseekProfile.onError", () => {
  it("retries a transient status with backoff and carries the translated error", () => {
    const d = deepseekProfile.onError(apiError(503), 1);
    expect(d.retry).toBe(true);
    expect(d).toMatchObject({ retry: true, delayMs: 1_000 });
    // The status now rides on the translated error, not a separate decision field.
    expect((d as { error: unknown }).error).toBeInstanceOf(ProviderError);
    expect(((d as { error: ProviderError }).error).status).toBe(503);
  });
  it("does not retry a non-retryable status, surfaces the translated error", () => {
    const d = deepseekProfile.onError(apiError(402), 1);
    expect(d.retry).toBe(false);
    expect(d.error).toBeInstanceOf(ProviderError);
    expect((d.error as ProviderError).status).toBe(402);
  });
  it("passes an undocumented/status-less error through untranslated", () => {
    const raw = new Error("socket hang up");
    expect(deepseekProfile.onError(raw, 1)).toEqual({ retry: false, error: raw });
  });
});

describe("moonshotProfile.thinking", () => {
  it("forces enabled + keep:all for the always-thinking code models, ignoring budget", () => {
    // kimi-k2.7-code rejects type:"disabled" and treats keep as "all".
    expect(moonshotProfile.thinking(0, "kimi-k2.7-code", "anthropic")).toEqual({
      params: { thinking: { type: "enabled", keep: "all" } },
    });
    // The -highspeed variant shares the same thinking behavior.
    expect(moonshotProfile.thinking(32_000, "kimi-k2.7-code-highspeed", "anthropic")).toEqual({
      params: { thinking: { type: "enabled", keep: "all" } },
    });
  });

  it("toggles type on budget for other Kimi models and never sends keep", () => {
    // kimi-k2.5 does NOT support the `keep` field.
    expect(moonshotProfile.thinking(0, "kimi-k2.5", "anthropic")).toEqual({
      params: { thinking: { type: "disabled" } },
    });
    expect(moonshotProfile.thinking(16_000, "kimi-k2.5", "anthropic")).toEqual({
      params: { thinking: { type: "enabled" } },
    });
  });

  it("imposes no max_tokens floor (effort-style knob, not budget_tokens)", () => {
    expect(moonshotProfile.thinking(16_000, "kimi-k2.5", "anthropic").minMaxTokens).toBeUndefined();
    expect(moonshotProfile.thinking(32_000, "kimi-k2.7-code", "anthropic").minMaxTokens).toBeUndefined();
  });
});

describe("otherProfile", () => {
  it("uses budget_tokens and imposes a max_tokens floor", () => {
    expect(otherProfile.thinking(16_000, undefined, "anthropic")).toEqual({
      params: { thinking: { type: "enabled", budget_tokens: 16_000 } },
      minMaxTokens: 16_000 + 8192,
    });
  });
  it("disables thinking at budget 0", () => {
    expect(otherProfile.thinking(0, undefined, "anthropic")).toEqual({ params: { thinking: { type: "disabled" } } });
  });
  it("never retries and passes the error through untouched", () => {
    const err = apiError(429);
    expect(otherProfile.onError(err, 1)).toEqual({ retry: false, error: err });
  });
});

describe("transport is orthogonal to provider", () => {
  it("deepseek sends its openai-wire thinking knob (thinking + reasoning_effort)", () => {
    // Disabled: only the switch, no effort.
    expect(deepseekProfile.thinking(0, "deepseek-chat", "openai")).toEqual({
      params: { thinking: { type: "disabled" } },
    });
    // Enabled: the switch plus the three-rung effort ladder.
    expect(deepseekProfile.thinking(8_000, "deepseek-v4-pro", "openai")).toEqual({
      params: { thinking: { type: "enabled" }, reasoning_effort: "low" },
    });
    expect(deepseekProfile.thinking(16_000, "deepseek-v4-pro", "openai")).toEqual({
      params: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    });
    expect(deepseekProfile.thinking(32_000, "deepseek-v4-pro", "openai")).toEqual({
      params: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    });
  });
  it("deepseek's anthropic-only output_config.effort never leaks onto the openai wire", () => {
    const params = deepseekProfile.thinking(16_000, "deepseek-v4-pro", "openai").params;
    expect(params.output_config).toBeUndefined();
  });
  it("moonshot sends no thinking knob on the openai wire either", () => {
    expect(moonshotProfile.thinking(16_000, "kimi-k2.7-code", "openai")).toEqual({ params: {} });
  });
  it("other sends no generic knob on the openai wire (budget ignored there)", () => {
    expect(otherProfile.thinking(16_000, undefined, "openai")).toEqual({ params: {} });
    expect(otherProfile.thinking(16_000, undefined, "openai").minMaxTokens).toBeUndefined();
  });
  it("deepseek keeps DeepSeek's error translation regardless of transport", () => {
    const d = deepseekProfile.onError(apiError(503), 1);
    expect(d.retry).toBe(true);
    expect(((d as { error: ProviderError }).error).provider).toBe("deepseek");
  });
});
