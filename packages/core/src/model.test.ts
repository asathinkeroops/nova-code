import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderError } from "./providers/error.js";
import { createAnthropicModel, type RetryNotice } from "./model.js";
import { deepseekProfile } from "./providers/deepseek.js";
import { otherProfile } from "./providers/other.js";

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

describe("createAnthropicModel thinking params", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    streamEvents = [];
  });

  it("sends budget_tokens for anthropic models", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "claude-sonnet-4-5", provider: otherProfile });
    await m.call({ ...baseReq, thinkingBudgetTokens: 16_000 });
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 16_000 });
    expect(params.output_config).toBeUndefined();
    // Anthropic requires max_tokens > budget_tokens — adapter auto-bumps.
    expect(params.max_tokens).toBe(16_000 + 8192);
  });

  it("sends output_config.effort for deepseek models, no budget_tokens", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-reasoner", provider: deepseekProfile });
    await m.call({ ...baseReq, thinkingBudgetTokens: 16_000 });
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "enabled" });
    expect(params.output_config).toEqual({ effort: "high" });
    // No budget on the DeepSeek path, so no max_tokens bump.
    expect(params.max_tokens).toBe(8192);
  });

  it("rounds max-level budget to effort:max on deepseek", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat", provider: deepseekProfile });
    await m.call({ ...baseReq, thinkingBudgetTokens: 32_000 });
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.output_config).toEqual({ effort: "max" });
  });

  it("estimates live output tokens from streamed deltas (not end-of-stream usage)", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    // 8 latin chars (~2.4 tok) + 4 CJK chars (~2.4 tok) → ceil = 5, and crucially
    // > 0 even though usage.output_tokens only lands in the final message.
    streamEvents = [delta("hello wo"), delta("世界你好")];
    const seen: number[] = [];
    const m = createAnthropicModel({
      apiKey: "x",
      model: "deepseek-chat",
      provider: deepseekProfile,
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
      provider: deepseekProfile,
      onStreamProgress: (p) => seen.push(p),
    });
    await m.call({ ...baseReq });
    // message_start → 125 uploaded (input + cache read + cache creation), output 0.
    expect(seen[0]).toEqual({ inputTokens: 125, outputTokens: 0 });
    // The uploaded count rides along with every later output update.
    expect(seen.at(-1)?.inputTokens).toBe(125);
    expect(seen.at(-1)?.outputTokens).toBeGreaterThan(0);
  });

  it("drives the thinking shape from the provider, not the model string", async () => {
    // A deepseek-named model on the `other` profile — it must send budget_tokens
    // (anthropic shape), not effort. Proves the wire shape follows the passed
    // provider, and the model id is just an id.
    mockCreate.mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat", provider: otherProfile });
    await m.call({ ...baseReq, thinkingBudgetTokens: 16_000 });
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 16_000 });
    expect(params.output_config).toBeUndefined();
    expect(params.max_tokens).toBe(16_000 + 8192);
  });

  it("sends explicit thinking: disabled and no output_config when budget is 0", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat", provider: deepseekProfile });
    await m.call({ ...baseReq });
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.output_config).toBeUndefined();
  });
});

function apiError(status: number): Error & { status: number } {
  return Object.assign(new Error(`${status} boom`), { status, headers: new Headers() });
}

describe("createAnthropicModel deepseek error handling", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    streamEvents = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient (429) error and then succeeds", async () => {
    vi.useFakeTimers();
    mockCreate.mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce(okResponse());
    const retries: RetryNotice[] = [];
    const m = createAnthropicModel({
      apiKey: "x",
      model: "deepseek-chat",
      provider: deepseekProfile,
      onRetry: (i) => retries.push(i),
    });
    const p = m.call({ ...baseReq });
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([{ attempt: 1, maxAttempts: 10, delayMs: 1_000, status: 429 }]);
  });

  it("retries malformed tool-call JSON (no status) and then succeeds", async () => {
    vi.useFakeTimers();
    // The SDK rejects finalMessage() with the wrapped JSON SyntaxError text.
    const jsonErr = new Error(
      "Expected ',' or '}' after property value in JSON at position 28 (line 1 column 29)",
    );
    mockCreate.mockRejectedValueOnce(jsonErr).mockResolvedValueOnce(okResponse());
    const retries: { attempt: number; status?: number; reason?: string }[] = [];
    const m = createAnthropicModel({
      apiKey: "x",
      model: "deepseek-chat",
      provider: deepseekProfile,
      onRetry: (i) => retries.push(i),
    });
    const p = m.call({ ...baseReq });
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([
      { attempt: 1, maxAttempts: 10, delayMs: 1_000, reason: "malformed-json" },
    ]);
  });

  it("retries malformed tool-call JSON for non-deepseek models too", async () => {
    vi.useFakeTimers();
    const jsonErr = new Error("Unexpected end of JSON input");
    mockCreate.mockRejectedValueOnce(jsonErr).mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "claude-sonnet-4-5", provider: otherProfile });
    const p = m.call({ ...baseReq });
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("retries a dropped connection (read ECONNRESET, no status) and then succeeds", async () => {
    vi.useFakeTimers();
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    mockCreate.mockRejectedValueOnce(reset).mockResolvedValueOnce(okResponse());
    const retries: RetryNotice[] = [];
    const m = createAnthropicModel({
      apiKey: "x",
      model: "deepseek-chat",
      provider: deepseekProfile,
      onRetry: (i) => retries.push(i),
    });
    const p = m.call({ ...baseReq });
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([{ attempt: 1, maxAttempts: 10, delayMs: 1_000, reason: "network" }]);
  });

  it("retries a dropped connection for non-deepseek models too", async () => {
    vi.useFakeTimers();
    // undici's `TypeError: terminated` with the socket error nested as the cause.
    const socket = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    mockCreate
      .mockRejectedValueOnce(new Error("terminated", { cause: socket }))
      .mockResolvedValueOnce(okResponse());
    const m = createAnthropicModel({ apiKey: "x", model: "claude-sonnet-4-5", provider: otherProfile });
    const p = m.call({ ...baseReq });
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("gives up after max attempts on a persistent dropped connection, rethrowing the raw error", async () => {
    vi.useFakeTimers();
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    mockCreate.mockRejectedValue(reset);
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat", provider: deepseekProfile });
    const caught = m.call({ ...baseReq }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200_000); // 9 backoffs: 1+2+4+8+16+30+30+30+30 = 151s
    const err = await caught;
    // No documented status → passed through untranslated, exactly as thrown.
    expect(err).toBe(reset);
    expect(mockCreate).toHaveBeenCalledTimes(10); // 1 + 9 retries
  });

  it("does not retry a connection error once the request signal has aborted", async () => {
    const ac = new AbortController();
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    mockCreate.mockImplementation(() => {
      ac.abort(); // the socket died because the user cancelled
      return Promise.reject(reset);
    });
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat", provider: deepseekProfile });
    const err = await m.call({ ...baseReq, signal: ac.signal }).catch((e: unknown) => e);
    expect(err).toBe(reset);
    expect(mockCreate).toHaveBeenCalledTimes(1); // no retry after abort
  });

  it("gives up after max attempts and throws a translated ProviderError", async () => {
    vi.useFakeTimers();
    mockCreate.mockRejectedValue(apiError(503));
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat", provider: deepseekProfile });
    const caught = m.call({ ...baseReq }).catch((e: unknown) => e);
    // Exhaust all 9 backoffs: 1+2+4+8+16+30+30+30+30 = 151s.
    await vi.advanceTimersByTimeAsync(200_000);
    const err = await caught;
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(503);
    expect(mockCreate).toHaveBeenCalledTimes(10); // 1 + 9 retries
  });

  it("throws a translated error for non-retryable (402) without retrying", async () => {
    mockCreate.mockRejectedValueOnce(apiError(402));
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat", provider: deepseekProfile });
    const err = await m.call({ ...baseReq }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(402);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("does not translate or retry errors for non-deepseek models", async () => {
    const orig = apiError(429);
    mockCreate.mockRejectedValue(orig);
    const m = createAnthropicModel({ apiKey: "x", model: "claude-sonnet-4-5", provider: otherProfile });
    const err = await m.call({ ...baseReq }).catch((e: unknown) => e);
    expect(err).toBe(orig); // untouched
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("createAnthropicModel onStreamText", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    streamEvents = [];
  });

  it("streams text and thinking deltas, but not tool-call json", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    streamEvents = [
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"a":1}' } },
    ];
    const seen: { text?: string; thinking?: string }[] = [];
    const m = createAnthropicModel({
      apiKey: "x",
      model: "deepseek-chat",
      provider: deepseekProfile,
      onStreamText: (d) => seen.push(d),
    });
    await m.call({ ...baseReq });
    // thinking + text are emitted as readable deltas; partial_json (tool args)
    // is skipped — it isn't prose and lands in the final message anyway.
    expect(seen).toEqual([{ thinking: "hmm" }, { text: "hello" }]);
  });

  it("works without onStreamProgress set", async () => {
    mockCreate.mockResolvedValueOnce(okResponse());
    streamEvents = [{ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }];
    const seen: { text?: string }[] = [];
    const m = createAnthropicModel({
      apiKey: "x",
      model: "deepseek-chat",
      provider: deepseekProfile,
      onStreamText: (d) => seen.push(d),
    });
    await m.call({ ...baseReq });
    expect(seen).toEqual([{ text: "hi" }]);
  });
});

describe("createAnthropicModel thinking backfill", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    streamEvents = [];
  });

  function thinkingDelta(thinking: string) {
    return { type: "content_block_delta", delta: { type: "thinking_delta", thinking } };
  }

  it("backfills streamed reasoning into an empty thinking block from finalMessage", async () => {
    // DeepSeek streams the reasoning (live preview) but reconstructs an EMPTY
    // thinking block in finalMessage — the adapter must re-attach the text.
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    streamEvents = [thinkingDelta("let me "), thinkingDelta("reason")];
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-reasoner", provider: deepseekProfile });
    const res = await m.call({ ...baseReq, thinkingBudgetTokens: 16_000 });
    expect(res.content[0]).toEqual({
      type: "thinking",
      thinking: "let me reason",
      signature: "",
    });
  });

  it("does not clobber a thinking block that already carries text", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "thinking", thinking: "real reasoning", signature: "sig" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    streamEvents = [thinkingDelta("streamed but should be ignored")];
    const m = createAnthropicModel({ apiKey: "x", model: "claude-sonnet-4-5", provider: otherProfile });
    const res = await m.call({ ...baseReq, thinkingBudgetTokens: 16_000 });
    expect(res.content[0]).toEqual({
      type: "thinking",
      thinking: "real reasoning",
      signature: "sig",
    });
  });

  it("leaves content untouched when no reasoning was streamed", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    streamEvents = [delta("answer")];
    const m = createAnthropicModel({ apiKey: "x", model: "deepseek-chat", provider: deepseekProfile });
    const res = await m.call({ ...baseReq });
    expect(res.content[0]).toEqual({ type: "thinking", thinking: "", signature: "" });
  });
});
