import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_TOKEN_ESTIMATE } from "@nova/base";
import type { ModelRequest, MessageParam } from "@nova/core";
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
import type { ProviderProfile } from "./providers/index.js";
import { createModel, type RetryNotice } from "./model.js";
import { buildOpenAIRequestBody, toOpenAIMessages } from "./openai.js";
import { deepseekProfile } from "./providers/deepseek.js";
import { otherProfile } from "./providers/other.js";
import { ProviderError } from "./providers/error.js";

// The transport goes through the official `openai` SDK, so these tests stub
// the SDK the same way model.test.ts stubs `@anthropic-ai/sdk`: the default
// export becomes a fake class whose `chat.completions.create` is a vi.fn the
// tests drive with fake async-iterable streams of `ChatCompletionChunk`.

const mockCreate = vi.fn();
// Constructor options of every SDK client the adapter built, so tests can
// assert what reached the SDK (baseURL, apiKey, maxRetries).
const clientOptions: Record<string, unknown>[] = [];
vi.mock("openai", () => {
  return {
    default: class {
      constructor(opts: Record<string, unknown>) {
        clientOptions.push(opts);
      }
      chat = {
        completions: {
          create: (...args: unknown[]) => mockCreate(...args),
        },
      };
    },
  };
});

/** An async-iterable stream of chunks, standing in for the SDK's `Stream`. */
async function* streamOf(chunks: ChatCompletionChunk[]): AsyncIterable<ChatCompletionChunk> {
  for (const c of chunks) yield c;
}

/** A local OpenAI-transport profile with a concrete thinking knob. */
const thinkingProfile: ProviderProfile = {
  id: "test-openai",
  transport: "openai",
  tokenEstimate: DEFAULT_TOKEN_ESTIMATE,
  thinking(budget, _model, _transport) {
    return budget > 0
      ? { params: { enable_thinking: true, thinking_budget: budget } }
      : { params: { enable_thinking: false } };
  },
  onError(err) {
    return { retry: false, error: err };
  },
};

const noopTool = {
  name: "noop",
  description: "no-op",
  inputSchema: z.object({}),
};

const baseReq: ModelRequest = {
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [noopTool],
  maxTokens: 8192,
};

function makeClient(
  profile: ProviderProfile = thinkingProfile,
  baseURL?: string,
  callbacks: { onStreamText?: (d: { text?: string; thinking?: string }) => void } = {},
) {
  return createModel({
    apiKey: "sk-test",
    model: "qwen3-coder-plus",
    baseURL: baseURL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    provider: profile,
    ...callbacks,
  });
}

function lastCreate(): {
  body: Record<string, unknown>;
  opts: Record<string, unknown>;
} {
  const [body, opts] = mockCreate.mock.calls.at(-1)! as [Record<string, unknown>, Record<string, unknown>];
  return { body, opts };
}

// ────────────────────────────────────────────────────────────────────────────
// Chunk factories (SDK-shaped, widened with the gateways' extensions)
// ────────────────────────────────────────────────────────────────────────────

function chunk(overrides: Partial<ChatCompletionChunk>): ChatCompletionChunk {
  return {
    id: "chunk_1",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [],
    ...overrides,
  } as unknown as ChatCompletionChunk;
}

function choice(delta: unknown, finishReason: string | null = null) {
  return { index: 0, delta, finish_reason: finishReason } as unknown as ChatCompletionChunk.Choice;
}

function textChunk(text: string): ChatCompletionChunk {
  return chunk({ choices: [choice({ content: text })] });
}

function reasoningChunk(text: string): ChatCompletionChunk {
  return chunk({ choices: [choice({ content: null, reasoning_content: text })] });
}

function toolCallChunk(partial: {
  index: number;
  id?: string;
  name?: string;
  args?: string;
}): ChatCompletionChunk {
  return chunk({
    choices: [
      choice({
        content: null,
        tool_calls: [
          {
            index: partial.index,
            ...(partial.id ? { id: partial.id } : {}),
            function: {
              ...(partial.name ? { name: partial.name } : {}),
              ...(partial.args ? { arguments: partial.args } : {}),
            },
          },
        ],
      }),
    ],
  });
}

function doneChunk(finishReason: string): ChatCompletionChunk {
  return chunk({ choices: [choice({}, finishReason)] });
}

function usageChunk(usage: Record<string, number>): ChatCompletionChunk {
  return chunk({ choices: [], usage: usage as unknown as ChatCompletionChunk["usage"] });
}

// ────────────────────────────────────────────────────────────────────────────
// Message mapping (pure)
// ────────────────────────────────────────────────────────────────────────────

describe("toOpenAIMessages", () => {
  it("prepends the system prompt as the first system message", () => {
    const out = toOpenAIMessages("sys", [{ role: "user", content: "hi" }]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("maps user images to image_url data URLs", () => {
    const out = toOpenAIMessages("sys", [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        ],
      },
    ]);
    expect(out[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    });
  });

  it("maps tool results to tool messages with tool_call_id", () => {
    const out = toOpenAIMessages("sys", [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
      },
    ]);
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok" });
  });

  it("prefixes Error: on is_error tool results (no error flag in OpenAI)", () => {
    const out = toOpenAIMessages("sys", [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "boom", is_error: true },
        ],
      },
    ]);
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Error: boom" });
  });

  it("round-trips assistant reasoning as reasoning_content and tool uses as tool_calls", () => {
    const out = toOpenAIMessages("sys", [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "" },
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "call_1", name: "noop", input: { a: 1 } },
        ],
      },
    ]);
    expect(out[1]).toEqual({
      role: "assistant",
      content: "let me check",
      reasoning_content: "hmm",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "noop", arguments: '{"a":1}' },
        },
      ],
    });
  });

  it("strips nova-internal meta exactly like the anthropic branch", () => {
    const msg: MessageParam = {
      role: "user",
      content: "injected",
      meta: { synthetic: true, kind: "todo-reminder" },
    };
    const out = toOpenAIMessages("sys", [msg]);
    expect(out[1]).toEqual({ role: "user", content: "injected" });
    expect(JSON.stringify(out)).not.toContain("meta");
  });
});

describe("buildOpenAIRequestBody", () => {
  it("frames tools in the OpenAI function shape and sets stream_options", () => {
    const body = buildOpenAIRequestBody(
      { ...baseReq, thinkingBudgetTokens: 16_000 },
      { apiKey: "k", model: "m", baseURL: "https://x/v1", provider: thinkingProfile },
      {
        maxTokens: 16_000,
        thinkingParams: { enable_thinking: true, thinking_budget: 16_000 },
        tools: [
          { name: "noop", description: "no-op", input_schema: { type: "object" } },
        ],
      },
    ) as unknown as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(16_000);
    // The profile's thinking knob lands verbatim in the body.
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(16_000);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "noop", description: "no-op", parameters: { type: "object" } },
      },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Transport end-to-end (via createModel dispatch)
// ────────────────────────────────────────────────────────────────────────────

describe("createModel openai transport", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    clientOptions.length = 0;
  });

  it("builds the SDK client with baseURL and maxRetries disabled", () => {
    makeClient(thinkingProfile);
    expect(clientOptions[0]).toMatchObject({
      apiKey: "sk-test",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      maxRetries: 0, // Nova owns the retry loop; SDK retries would double it
    });
  });

  it("streams chat.completions with the framed body", async () => {
    mockCreate.mockResolvedValueOnce(streamOf([textChunk("ok"), doneChunk("stop")]));
    const m = makeClient();
    await m.call({ ...baseReq, thinkingBudgetTokens: 16_000 });
    const { body, opts } = lastCreate();
    expect(body.model).toBe("qwen3-coder-plus");
    expect(body.stream).toBe(true);
    expect((body.messages as Array<Record<string, unknown>>)[0]).toEqual({
      role: "system",
      content: "sys",
    });
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(16_000);
    expect(opts).not.toHaveProperty("signal");
  });

  it("passes the request signal through to the SDK", async () => {
    mockCreate.mockResolvedValueOnce(streamOf([textChunk("ok"), doneChunk("stop")]));
    const ac = new AbortController();
    const m = makeClient();
    await m.call({ ...baseReq, signal: ac.signal });
    expect(lastCreate().opts.signal).toBe(ac.signal);
  });

  it("merges configured headers at request level so they override auth", async () => {
    mockCreate.mockResolvedValueOnce(streamOf([textChunk("ok"), doneChunk("stop")]));
    const m = createModel({
      apiKey: "sk-test",
      model: "m",
      baseURL: "https://gw.example.com/v1",
      provider: thinkingProfile,
      headers: { "X-Tenant": "acme", Authorization: "Bearer gateway-token" },
    });
    await m.call({ ...baseReq, tools: [] });
    expect(lastCreate().opts.headers).toEqual({
      "X-Tenant": "acme",
      Authorization: "Bearer gateway-token",
    });
  });

  it("throws a clear error when an openai profile has no baseURL", async () => {
    const m = createModel({ apiKey: "sk-test", model: "m", provider: thinkingProfile });
    const err = await m.call(baseReq).catch((e: unknown) => e);
    expect(String(err)).toContain("requires a `baseURL`");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("streams text deltas and returns the accumulated turn", async () => {
    mockCreate.mockResolvedValueOnce(streamOf([textChunk("hello "), textChunk("world"), doneChunk("stop")]));
    const m = makeClient(thinkingProfile);
    const res = await m.call({ ...baseReq, tools: [] });
    expect(res.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(res.stopReason).toBe("end_turn");
  });

  it("emits onStreamText per text and reasoning delta, but not tool-call json", async () => {
    mockCreate.mockResolvedValueOnce(
      streamOf([
        reasoningChunk("hmm"),
        textChunk("answer"),
        toolCallChunk({ index: 0, id: "c1", name: "noop", args: '{"a":1}' }),
        doneChunk("tool_calls"),
      ]),
    );
    const seen: { text?: string; thinking?: string }[] = [];
    const m = makeClient(thinkingProfile, undefined, { onStreamText: (d) => seen.push(d) });
    const res = await m.call(baseReq);
    expect(seen).toEqual([{ thinking: "hmm" }, { text: "answer" }]);
    expect(res.content[0]).toEqual({ type: "thinking", thinking: "hmm", signature: "" });
    expect(res.content[1]).toEqual({ type: "text", text: "answer" });
    expect(res.content[2]).toEqual({
      type: "tool_use",
      id: "c1",
      name: "noop",
      input: { a: 1 },
    });
    expect(res.stopReason).toBe("tool_use");
  });

  it("accumulates tool-call arguments split across chunks", async () => {
    mockCreate.mockResolvedValueOnce(
      streamOf([
        toolCallChunk({ index: 0, id: "c1", name: "read", args: '{"path":' }),
        toolCallChunk({ index: 0, args: '"/a"}' }),
        doneChunk("tool_calls"),
      ]),
    );
    const m = makeClient(thinkingProfile);
    const res = await m.call(baseReq);
    expect(res.content[0]).toEqual({
      type: "tool_use",
      id: "c1",
      name: "read",
      input: { path: "/a" },
    });
  });

  it("maps finish_reason length to max_tokens and content_filter to refusal", async () => {
    mockCreate.mockResolvedValueOnce(streamOf([textChunk("partial"), doneChunk("length")]));
    const m = makeClient(thinkingProfile);
    expect((await m.call(baseReq)).stopReason).toBe("max_tokens");

    mockCreate.mockResolvedValueOnce(streamOf([textChunk("nope"), doneChunk("content_filter")]));
    expect((await m.call(baseReq)).stopReason).toBe("refusal");
  });

  it("maps DeepSeek's two-bucket usage: miss is the uncached input, not cache creation", async () => {
    mockCreate.mockResolvedValueOnce(
      streamOf([
        textChunk("ok"),
        // DeepSeek reports prompt_tokens == hit + miss (no third "uncached"
        // bucket); its miss tokens are billed at full input price, so they must
        // land in `inputTokens` — exactly where the anthropic wire's
        // `input_tokens` lands — not in cacheCreationInputTokens.
        usageChunk({
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 60,
        }),
        doneChunk("stop"),
      ]),
    );
    const m = makeClient(thinkingProfile);
    const res = await m.call(baseReq);
    expect(res.usage).toEqual({
      inputTokens: 60, // the uncached (full-price) input, not 0
      outputTokens: 5,
      cacheReadInputTokens: 40,
    });
    // The three buckets still sum to the reported prompt total.
    expect(
      res.usage!.inputTokens +
        res.usage!.cacheReadInputTokens! +
        (res.usage!.cacheCreationInputTokens ?? 0),
    ).toBe(100);
  });

  it("keeps a three-bucket gateway's uncached remainder and cache write separate", async () => {
    mockCreate.mockResolvedValueOnce(
      streamOf([
        textChunk("ok"),
        // A gateway with a real uncached remainder (prompt_tokens > hit + miss)
        // keeps the three-bucket mapping: subtract the cache subsets, keep miss
        // as the cache-write bucket.
        usageChunk({
          prompt_tokens: 200,
          completion_tokens: 5,
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 60,
        }),
        doneChunk("stop"),
      ]),
    );
    const m = makeClient(thinkingProfile);
    const res = await m.call(baseReq);
    expect(res.usage).toEqual({
      inputTokens: 100, // 200 - 40 - 60
      outputTokens: 5,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 60,
    });
  });

  it("keeps prompt_tokens as inputTokens when the gateway reports no cache fields", async () => {
    mockCreate.mockResolvedValueOnce(
      streamOf([
        textChunk("ok"),
        usageChunk({ prompt_tokens: 100, completion_tokens: 5 }),
        doneChunk("stop"),
      ]),
    );
    const m = makeClient(thinkingProfile);
    const res = await m.call(baseReq);
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 5 });
  });

  it("subtracts only the cache fields that are present", async () => {
    mockCreate.mockResolvedValueOnce(
      streamOf([
        textChunk("ok"),
        usageChunk({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 40 }),
        doneChunk("stop"),
      ]),
    );
    const m = makeClient(thinkingProfile);
    const res = await m.call(baseReq);
    expect(res.usage).toEqual({
      inputTokens: 60,
      outputTokens: 5,
      cacheReadInputTokens: 40,
    });
  });

  it("omits usage when the gateway never sends it", async () => {
    mockCreate.mockResolvedValueOnce(streamOf([textChunk("ok"), doneChunk("stop")]));
    const m = makeClient(thinkingProfile);
    const res = await m.call(baseReq);
    expect(res.usage).toBeUndefined();
  });

  it("drops tool calls the model never finished describing (truncated by max_tokens)", async () => {
    mockCreate.mockResolvedValueOnce(
      streamOf([
        // id present but name/arguments never streamed before the cut-off.
        toolCallChunk({ index: 0, id: "c1", args: '{"p":' }),
        doneChunk("length"),
      ]),
    );
    const m = makeClient(thinkingProfile);
    const res = await m.call(baseReq);
    // Incomplete call dropped, turn reports max_tokens.
    expect(res.content).toEqual([]);
    expect(res.stopReason).toBe("max_tokens");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Retry behavior on the openai branch (shared loop, SDK errors)
// ────────────────────────────────────────────────────────────────────────────

function apiError(
  status: number,
  opts: { detail?: string; retryAfter?: string } = {},
): Error & { status: number } {
  const headers = new Headers();
  if (opts.retryAfter !== undefined) headers.set("retry-after", opts.retryAfter);
  return Object.assign(new Error(`${status} boom`), {
    status,
    headers,
    ...(opts.detail ? { error: { message: opts.detail, type: "x", code: "y" } } : {}),
  });
}

describe("createModel openai transport retries", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    clientOptions.length = 0;
  });

  it("retries a transient 429 (translated by the provider) and then succeeds", async () => {
    vi.useFakeTimers();
    mockCreate
      .mockRejectedValueOnce(apiError(429, { detail: "rate limited" }))
      .mockResolvedValueOnce(streamOf([textChunk("ok"), doneChunk("stop")]));
    const retries: RetryNotice[] = [];
    const m = createModel({
      apiKey: "x",
      model: "m",
      baseURL: "https://gw.example.com/v1",
      // DeepSeek's error translation rides on the openai transport unchanged.
      provider: deepseekProfile,
      transport: "openai",
      onRetry: (i) => retries.push(i),
    });
    const p = m.call(baseReq);
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([{ attempt: 1, maxAttempts: 10, delayMs: 1_000, status: 429 }]);
  });

  it("throws a translated ProviderError for a non-retryable 402 without retrying", async () => {
    mockCreate.mockRejectedValueOnce(apiError(402, { detail: "balance empty" }));
    const m = createModel({
      apiKey: "sk-test",
      model: "deepseek-reasoner",
      baseURL: "https://api.deepseek.com",
      provider: deepseekProfile,
      transport: "openai",
    });
    const err = await m.call(baseReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(402);
    expect((err as ProviderError).message).toContain("balance empty");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("retries a dropped connection (read ECONNRESET, no status)", async () => {
    vi.useFakeTimers();
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    mockCreate
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce(streamOf([textChunk("ok"), doneChunk("stop")]));
    const m = makeClient(thinkingProfile);
    const p = m.call(baseReq);
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("retries malformed tool-call JSON once, then succeeds", async () => {
    vi.useFakeTimers();
    // Arguments arrive truncated — `JSON.parse` throws the V8 SyntaxError that
    // `isMalformedToolJsonError` matches, so the shared loop re-issues.
    mockCreate
      .mockResolvedValueOnce(streamOf([toolCallChunk({ index: 0, id: "c1", name: "read", args: '{"path":' }), doneChunk("tool_calls")]))
      .mockResolvedValueOnce(streamOf([toolCallChunk({ index: 0, id: "c1", name: "read", args: '{"path":"/a"}' }), doneChunk("tool_calls")]));
    const m = makeClient(thinkingProfile);
    const p = m.call(baseReq);
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.content[0]).toMatchObject({ name: "read", input: { path: "/a" } });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("does not retry after the request signal aborts", async () => {
    const ac = new AbortController();
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    mockCreate.mockImplementation(() => {
      ac.abort(); // the socket died because the user cancelled
      return Promise.reject(reset);
    });
    const m = makeClient(thinkingProfile);
    const err = await m.call({ ...baseReq, signal: ac.signal }).catch((e: unknown) => e);
    expect(err).toBe(reset);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dispatch
// ────────────────────────────────────────────────────────────────────────────

describe("createModel transport dispatch", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    clientOptions.length = 0;
  });

  it("builds the OpenAI SDK client for openai profiles", () => {
    makeClient(thinkingProfile);
    expect(clientOptions.length).toBe(1);
    expect(clientOptions[0]?.maxRetries).toBe(0);
  });

  it("leaves anthropic profiles on the Anthropic SDK (no OpenAI client)", () => {
    createModel({ apiKey: "x", model: "claude-sonnet-4-5", provider: otherProfile });
    expect(clientOptions.length).toBe(0);
  });

  it("switches a deepseek provider to the openai wire via the transport override", async () => {
    // The transport is orthogonal to the provider: DeepSeek serves both
    // endpoints, and `settings.transport: "openai"` + the plain baseURL must
    // route through the OpenAI SDK while keeping DeepSeek's profile.
    mockCreate.mockResolvedValueOnce(streamOf([textChunk("ok"), doneChunk("stop")]));
    const m = createModel({
      apiKey: "x",
      model: "deepseek-reasoner",
      baseURL: "https://api.deepseek.com",
      provider: deepseekProfile,
      transport: "openai",
    });
    const res = await m.call({ ...baseReq, thinkingBudgetTokens: 16_000 });
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(clientOptions.length).toBe(1); // OpenAI client, not Anthropic
    expect(lastCreate().body.model).toBe("deepseek-reasoner");
    // DeepSeek's anthropic-only `output_config.effort` knob must NOT leak onto
    // the openai wire; that wire gets its own thinking shape instead
    // (`thinking` switch + `reasoning_effort` ladder).
    expect(lastCreate().body.output_config).toBeUndefined();
    expect(lastCreate().body.thinking).toEqual({ type: "enabled" });
    expect(lastCreate().body.reasoning_effort).toBe("high"); // 16_000 budget → high
  });

  it("keeps a deepseek provider on the anthropic wire by default (no override)", () => {
    createModel({ apiKey: "x", model: "deepseek-v4-pro", provider: deepseekProfile });
    expect(clientOptions.length).toBe(0); // no OpenAI client built
  });
});
