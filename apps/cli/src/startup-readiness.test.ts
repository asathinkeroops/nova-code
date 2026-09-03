import { describe, expect, it } from "vitest";
import { parseSettings } from "@nova/base";
import { settingsReadiness } from "./startup-readiness.js";

describe("settingsReadiness", () => {
  it("requires an API key", () => {
    expect(settingsReadiness(parseSettings({}), {})).toBe("missing-api-key");
  });

  it("rejects an environment key without a configured model table", () => {
    expect(
      settingsReadiness(parseSettings({}), {
        NOVA_API_KEY: "sk-from-env",
      }),
    ).toBe("missing-models");
  });

  it("rejects a configured key without a model table", () => {
    const settings = parseSettings({
      providers: [{ name: "generic", profile: "generic", apiKey: "sk-configured" }],
    });
    expect(settingsReadiness(settings, {})).toBe("missing-models");
  });

  it("accepts the active provider's key and built-in models", () => {
    const settings = parseSettings({
      currentProvider: "deepseek",
      providers: [
        {
          name: "deepseek",
          profile: "deepseek",
          baseURL: "https://api.deepseek.com",
          transport: "openai",
          apiKey: "sk-configured",
        },
      ],
    });

    expect(settingsReadiness(settings, {})).toBe("ready");
  });

  it("requires baseURL for an OpenAI-compatible transport", () => {
    const settings = parseSettings({
      providers: [
        {
          name: "deepseek",
          profile: "deepseek",
          transport: "openai",
          apiKey: "sk-configured",
        },
      ],
    });

    expect(settingsReadiness(settings, {})).toBe("missing-base-url");
  });

  it("requires baseURL for DeepSeek and Moonshot on their Anthropic wires", () => {
    for (const profile of ["deepseek", "moonshot"] as const) {
      const settings = parseSettings({
        providers: [{ name: profile, profile, transport: "anthropic", apiKey: "sk-configured" }],
      });
      expect(settingsReadiness(settings, {})).toBe("missing-base-url");
    }
  });

  it("allows the generic Anthropic profile to use the SDK default endpoint", () => {
    const models = {
      lite: { id: "claude-lite" },
      pro: { id: "claude-pro" },
      max: { id: "claude-max" },
    };
    const settings = parseSettings({
      providers: [{ name: "generic", profile: "generic", apiKey: "sk-configured", models }],
    });

    expect(settingsReadiness(settings, {})).toBe("ready");
  });
});
