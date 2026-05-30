import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAnthropicModel, detectThinkingFormat } from "./model.js";

// Stub the Anthropic SDK so we can inspect the params our adapter sends
// without making a network call. The adapter streams, so `stream(...)` returns
// a handle exposing `.on("streamEvent", …)` and `finalMessage()`. Tests can
// queue `streamEvents` to be replayed to listeners when finalMessage resolves.
const mockCreate = vi.fn();
let streamEvents: unknown[] = [];
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = {
        stream: (...args: unknown[]) => {
          const listeners: ((event: unknown) => void)[] = [];
          return {
            on(event: string, fn: (event: unknown) => void) {
              if (event === "streamEvent") listeners.push(fn);
              return this;
            },
            finalMessage() {
              for (const e of streamEvents) for (const fn of listeners) fn(e);
              return mockCreate(...args);
            },
          };
        },
      };
    },
  };
});

function delta(text: string) {
  return { type: "content_block_delta", delta: { type: "text_delta", text } };
}

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
    streamEvents = [];
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

  it("estimates live output tokens from streamed deltas (not end-of-stream usage)", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    // 8 latin chars (~2 tok) + 4 CJK chars (~2.4 tok) → ceil = 5, and crucially
    // > 0 even though usage.output_tokens only lands in the final message.
    streamEvents = [delta("hello wo"), delta("世界你好")];
    const seen: number[] = [];
    const m = createAnthropicModel({
      apiKey: "x",
      model: "deepseek-chat",
      onStreamProgress: (p) => seen.push(p.outputTokens),
    });
    await m.call({ ...baseReq });
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(Math.ceil(4 * 0.6 + 8 / 4));
  });

  it("reports real uploaded prompt tokens from message_start", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    streamEvents = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
        },
      },
      delta("hi"),
    ];
    const seen: { inputTokens?: number; outputTokens: number }[] = [];
    const m = createAnthropicModel({
      apiKey: "x",
      model: "deepseek-chat",
      onStreamProgress: (p) => seen.push(p),
    });
    await m.call({ ...baseReq });
    // message_start → 125 uploaded (input + cache read + cache creation), output 0.
    expect(seen[0]).toEqual({ inputTokens: 125, outputTokens: 0 });
    // The uploaded count rides along with every later output update.
    expect(seen.at(-1)?.inputTokens).toBe(125);
    expect(seen.at(-1)?.outputTokens).toBeGreaterThan(0);
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
