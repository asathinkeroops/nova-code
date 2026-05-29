import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAnthropicModel, detectThinkingFormat } from "./model.js";

// Stub the Anthropic SDK so we can inspect the params our adapter sends
// without making a network call.
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = {
        create: (...args: unknown[]) => mockCreate(...args),
      };
    },
  };
});

function okResponse() {
  return {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const baseReq = {
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [
    {
      name: "noop",
      description: "no-op",
      inputSchema: z.object({}),
    },
  ],
  maxTokens: 8192,
};

describe("detectThinkingFormat", () => {
  it("flags deepseek model ids", () => {
    expect(detectThinkingFormat("deepseek-chat")).toBe("deepseek");
    expect(detectThinkingFormat("deepseek-reasoner")).toBe("deepseek");
    expect(detectThinkingFormat("DeepSeek-V3")).toBe("deepseek");
  });
  it("defaults to anthropic for other ids", () => {
    expect(detectThinkingFormat("claude-sonnet-4-5")).toBe("anthropic");
    expect(detectThinkingFormat("claude-opus-4-7")).toBe("anthropic");
  });
});

describe("createAnthropicModel thinking params", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("sends budget_tokens for anthropic models", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "claude-sonnet-4-5" });
    await m.call({ ...baseReq, thinkingBudgetTokens: 16_000 });
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 16_000 });
    expect(params.output_config).toBeUndefined();
    // Anthropic requires max_tokens > budget_tokens — adapter auto-bumps.
    expect(params.max_tokens).toBe(16_000 + 8192);
  });

  it("sends output_config.effort for deepseek models, no budget_tokens", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-reasoner" });
    await m.call({ ...baseReq, thinkingBudgetTokens: 16_000 });
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "enabled" });
    expect(params.output_config).toEqual({ effort: "high" });
    // No budget on the DeepSeek path, so no max_tokens bump.
    expect(params.max_tokens).toBe(8192);
  });

  it("rounds max-level budget to effort:max on deepseek", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat" });
    await m.call({ ...baseReq, thinkingBudgetTokens: 32_000 });
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.output_config).toEqual({ effort: "max" });
  });

  it("sends explicit thinking: disabled and no output_config when budget is 0", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat" });
    await m.call({ ...baseReq });
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.output_config).toBeUndefined();
  });
});
