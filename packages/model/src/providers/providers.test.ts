import { describe, expect, it } from "vitest";
import { deepseekProfile } from "./deepseek.js";
import { ProviderError } from "./error.js";
import { genericProfile } from "./generic.js";
import { isProviderId, PROVIDER_IDS, PROVIDERS, resolveProfile } from "./index.js";
import { moonshotProfile } from "./moonshot.js";

function apiError(status: number, retryAfter?: string): Error & { status: number } {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return Object.assign(new Error(`${status} boom`), { status, headers });
}

describe("resolveProfile", () => {
  it("maps a provider id to its profile", () => {
    expect(resolveProfile("deepseek")).toBe(deepseekProfile);
    expect(resolveProfile("moonshot")).toBe(moonshotProfile);
    expect(resolveProfile("generic")).toBe(genericProfile);
  });

  it("registers the built-in profiles under their id", () => {
    expect(PROVIDERS.deepseek).toBe(deepseekProfile);
    expect(PROVIDERS.moonshot).toBe(moonshotProfile);
    expect(PROVIDERS.generic).toBe(genericProfile);
  });

  it("falls back to the `generic` profile for an unknown id", () => {
    // A provider entry's `profile` is a free-form string, so a typo or a generic
    // provider named directly resolves to the generic fallback, never throws.
    expect(resolveProfile("deepsek")).toBe(genericProfile);
    expect(resolveProfile("some-third-party")).toBe(genericProfile);
  });
});

describe("provider id helpers", () => {
  it("PROVIDER_IDS lists exactly the registry keys", () => {
    expect([...PROVIDER_IDS].sort()).toEqual(["deepseek", "generic", "moonshot"]);
    expect([...PROVIDER_IDS].sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  it("isProviderId narrows built-in ids and rejects the rest", () => {
    expect(isProviderId("deepseek")).toBe(true);
    expect(isProviderId("generic")).toBe(true);
    expect(isProviderId("other")).toBe(false);
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
    expect(genericProfile.transport).toBeUndefined();
  });
});

describe("deepseekProfile.thinking", () => {
  it("leaves the endpoint default untouched for auto", () => {
    expect(deepseekProfile.thinking("auto", undefined, "anthropic")).toEqual({ params: {} });
  });
  it("disables thinking for off", () => {
    expect(deepseekProfile.thinking("off", undefined, "anthropic")).toEqual({
      params: { thinking: { type: "disabled" } },
    });
  });
  it("maps positive levels below max to effort:high", () => {
    expect(deepseekProfile.thinking("low", undefined, "anthropic")).toEqual({
      params: { thinking: { type: "enabled" }, output_config: { effort: "high" } },
    });
    expect(deepseekProfile.thinking("high", undefined, "anthropic")).toEqual({
      params: { thinking: { type: "enabled" }, output_config: { effort: "high" } },
    });
  });
  it("maps max to effort:max", () => {
    expect(deepseekProfile.thinking("max", undefined, "anthropic").params).toEqual({
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
  it("forces enabled + keep:all for the always-thinking code models, ignoring level", () => {
    // kimi-k2.7-code rejects type:"disabled" and treats keep as "all".
    expect(moonshotProfile.thinking("off", "kimi-k2.7-code", "anthropic")).toEqual({
      params: { thinking: { type: "enabled", keep: "all" } },
    });
    // The -highspeed variant shares the same thinking behavior.
    expect(moonshotProfile.thinking("auto", "kimi-k2.7-code-highspeed", "anthropic")).toEqual({
      params: { thinking: { type: "enabled", keep: "all" } },
    });
  });

  it("leaves auto unset and toggles explicit levels for other Kimi models", () => {
    // kimi-k2.5 does NOT support the `keep` field.
    expect(moonshotProfile.thinking("auto", "kimi-k2.5", "anthropic")).toEqual({ params: {} });
    expect(moonshotProfile.thinking("off", "kimi-k2.5", "anthropic")).toEqual({
      params: { thinking: { type: "disabled" } },
    });
    expect(moonshotProfile.thinking("high", "kimi-k2.5", "anthropic")).toEqual({
      params: { thinking: { type: "enabled" } },
    });
  });
});

describe("genericProfile", () => {
  it("leaves the endpoint default untouched for auto", () => {
    expect(genericProfile.thinking("auto", undefined, "anthropic")).toEqual({ params: {} });
    expect(genericProfile.thinking("auto", undefined, "openai")).toEqual({ params: {} });
  });
  it("maps Anthropic levels to adaptive thinking and output_config.effort", () => {
    expect(genericProfile.thinking("off", undefined, "anthropic")).toEqual({
      params: { thinking: { type: "disabled" } },
    });
    for (const level of ["low", "medium", "high", "max"] as const) {
      expect(genericProfile.thinking(level, undefined, "anthropic")).toEqual({
        params: { thinking: { type: "adaptive" }, output_config: { effort: level } },
      });
    }
  });
  it("maps OpenAI levels to reasoning_effort", () => {
    expect(genericProfile.thinking("off", undefined, "openai")).toEqual({
      params: { reasoning_effort: "none" },
    });
    for (const level of ["low", "medium", "high", "max"] as const) {
      expect(genericProfile.thinking(level, undefined, "openai")).toEqual({
        params: { reasoning_effort: level },
      });
    }
  });
  it("retries common transient HTTP statuses with exponential backoff", () => {
    for (const status of [408, 409, 429, 500, 503, 599]) {
      const decision = genericProfile.onError(apiError(status), 2);
      expect(decision).toMatchObject({ retry: true, delayMs: 2_000 });
      expect(decision.error).toBeInstanceOf(ProviderError);
      expect((decision.error as ProviderError).status).toBe(status);
    }
  });
  it("honors Retry-After for a retryable error", () => {
    const decision = genericProfile.onError(apiError(429, "7"), 1);
    expect(decision).toMatchObject({ retry: true, delayMs: 7_000 });
    expect((decision.error as ProviderError).retryAfterSeconds).toBe(7);
  });
  it("does not retry permanent or status-less errors", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const err = apiError(status);
      expect(genericProfile.onError(err, 1)).toEqual({ retry: false, error: err });
    }
    const err = new Error("boom");
    expect(genericProfile.onError(err, 1)).toEqual({ retry: false, error: err });
  });
});

describe("transport is orthogonal to provider", () => {
  it("deepseek sends its openai-wire thinking knob (thinking + reasoning_effort)", () => {
    // Disabled: only the switch, no effort.
    expect(deepseekProfile.thinking("off", "deepseek-chat", "openai")).toEqual({
      params: { thinking: { type: "disabled" } },
    });
    // Enabled: the switch plus the three-rung effort ladder.
    expect(deepseekProfile.thinking("medium", "deepseek-v4-pro", "openai")).toEqual({
      params: { thinking: { type: "enabled" }, reasoning_effort: "low" },
    });
    expect(deepseekProfile.thinking("high", "deepseek-v4-pro", "openai")).toEqual({
      params: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    });
    expect(deepseekProfile.thinking("max", "deepseek-v4-pro", "openai")).toEqual({
      params: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    });
  });
  it("deepseek's anthropic-only output_config.effort never leaks onto the openai wire", () => {
    const params = deepseekProfile.thinking("high", "deepseek-v4-pro", "openai").params;
    expect(params.output_config).toBeUndefined();
  });
  it("moonshot sends no thinking knob on the openai wire either", () => {
    expect(moonshotProfile.thinking("high", "kimi-k2.7-code", "openai")).toEqual({ params: {} });
  });
  it("deepseek keeps DeepSeek's error translation regardless of transport", () => {
    const d = deepseekProfile.onError(apiError(503), 1);
    expect(d.retry).toBe(true);
    expect(((d as { error: ProviderError }).error).provider).toBe("deepseek");
  });
});
