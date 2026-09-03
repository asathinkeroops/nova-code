import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import { toWireMessages, toWireTools, type ModelRequest } from "@nova/core";
import { isCjkCodePoint } from "@nova/base";
import type {
  AssistantTurn,
  ContentBlock,
  MessageParam,
  StopReason,
  ToolResultBlock,
} from "@nova/core";
import type { ProviderProfile, ThinkingParams } from "./providers/index.js";
import type { StreamProgress, StreamTextDelta } from "./model.js";

/**
 * The OpenAI-compatible transport: the second wire branch of the model adapter.
 *
 * Qwen / GLM / MiniMax / Doubao are native to OpenAI's `chat/completions`
 * format, which the Anthropic SDK cannot speak, so this branch talks to them
 * through the official `openai` SDK (`maxRetries: 0` — Nova owns the retry
 * loop; the SDK's own retries would double it). The SDK does the HTTP + SSE
 * decoding; what it does NOT know about is the Chinese gateways' non-standard
 * extensions this branch lives on:
 *
 *   - `delta.reasoning_content` (DeepSeek / Qwen / GLM reasoning) — absent from
 *     the SDK's `Delta` type, read via a narrow cast;
 *   - `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` — absent
 *     from `CompletionUsage`, same treatment;
 *   - the per-profile thinking knob (`enable_thinking`, `thinking: { … }`) —
 *     not in `ChatCompletionCreateParams`, injected into the body verbatim.
 *
 * The request body is still assembled byte-by-byte here (system as the first
 * `system` message, `toWireMessages`-stripped history, `stream_options` so the
 * final chunk carries real usage) and handed to the SDK's `create` as the
 * params object — serialization order follows the object's key order, so the
 * body stays byte-stable across turns and a provider's automatic prefix cache
 * keeps hitting. Streaming accumulates the same way the Anthropic branch does:
 * text / reasoning deltas ride `onStreamText`, live token estimates count
 * streamed chars against the profile's `tokenEstimate`, tool calls arrive as
 * incremental `tool_calls` deltas keyed by `index` and must be merged across
 * chunks, and real usage lands in the final chunk.
 */

/** An OpenAI SDK client narrowed to the streaming calls this transport makes. */
export type OpenAIClient = Pick<OpenAI, "chat">;

interface OpenAIModelConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  headers?: Record<string, string>;
  provider: ProviderProfile;
  onStreamProgress?: (progress: StreamProgress) => void;
  onStreamText?: (delta: StreamTextDelta) => void;
}

interface RequestFraming {
  maxTokens: number;
  thinkingParams: ThinkingParams["params"];
  tools: ReturnType<typeof toWireTools>;
}

/**
 * Build the transport's OpenAI SDK client. `maxRetries: 0` is load-bearing:
 * the shared retry loop in `createModel` classifies and retries by provider
 * policy, so an SDK-side retry would fire first and double every backoff.
 */
export function createOpenAIClient(config: OpenAIModelConfig): OpenAIClient {
  return new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    maxRetries: 0,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Request framing
// ────────────────────────────────────────────────────────────────────────────

/** A user message's content parts, split for the OpenAI wire shape. */
function splitUserContent(msg: MessageParam): {
  text: string[];
  images: string[];
  toolResults: ToolResultBlock[];
} {
  const text: string[] = [];
  const images: string[] = [];
  const toolResults: ToolResultBlock[] = [];
  if (typeof msg.content === "string") {
    text.push(msg.content);
    return { text, images, toolResults };
  }
  for (const block of msg.content) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "image")
      images.push(`data:${block.source.media_type};base64,${block.source.data}`);
    else if (block.type === "tool_result") toolResults.push(block);
    // thinking / redacted_thinking blocks inside a user message: not a shape
    // OpenAI has — dropped (they are assistant-side in canonical history).
  }
  return { text, images, toolResults };
}

/**
 * Render the text OpenAI `tool` messages carry and extract legacy nested image
 * blocks. New Nova histories store rich output as top-level user messages, but
 * resumed sessions may still contain Anthropic-shaped images inside a
 * tool_result; promote those images instead of silently dropping them.
 */
function serializeToolResult(result: ToolResultBlock): { text: string; images: string[] } {
  const text =
    typeof result.content === "string"
      ? result.content
      : result.content
          .filter(
            (b): b is Extract<(typeof result.content)[number], { type: "text" }> =>
              b.type === "text",
          )
          .map((b) => b.text)
          .join("\n");
  const images = Array.isArray(result.content)
    ? result.content
        .filter(
          (b): b is Extract<(typeof result.content)[number], { type: "image" }> =>
            b.type === "image",
        )
        .map((b) => `data:${b.source.media_type};base64,${b.source.data}`)
    : [];
  // OpenAI has no per-result error flag; the Anthropic wire's `is_error` is
  // folded into a leading "Error: " so the model still sees the failure.
  const head = result.is_error ? "Error: " : "";
  return { text: `${head}${text}`, images };
}

function mergeUserParts(text: string[], images: string[]): string | Array<Record<string, unknown>> {
  if (images.length === 0) return text.join("\n");
  const parts: Array<Record<string, unknown>> = [];
  if (text.length > 0) parts.push({ type: "text", text: text.join("\n") });
  for (const url of images) parts.push({ type: "image_url", image_url: { url } });
  return parts;
}

/**
 * Map canonical history to OpenAI chat message objects. The system prompt is
 * prepended as the first `system` message — byte-identical to the previous
 * request while the epoch is frozen, so prefix caching holds. `meta` is stripped
 * by {@link toWireMessages} exactly as on the Anthropic branch.
 */
export function toOpenAIMessages(
  system: string,
  messages: MessageParam[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const msg of toWireMessages(messages)) {
    if (msg.role === "user") {
      const { text, images, toolResults } = splitUserContent(msg);
      if (toolResults.length > 0) {
        // Every tool call must receive its `tool` message before the next user
        // input. Canonical Anthropic-shaped messages may carry ordinary user
        // content after their leading tool_result blocks, so split that tail
        // and emit it only after all tool messages. Legacy images nested inside
        // tool_result are promoted into the same provider-neutral user input.
        const promotedImages: string[] = [];
        for (const result of toolResults) {
          const serialized = serializeToolResult(result);
          out.push({
            role: "tool",
            tool_call_id: result.tool_use_id,
            content: serialized.text,
          });
          promotedImages.push(...serialized.images);
        }
        const userImages = [...images, ...promotedImages];
        if (text.length > 0 || userImages.length > 0) {
          out.push({ role: "user", content: mergeUserParts(text, userImages) });
        }
        continue;
      }
      out.push({ role: "user", content: mergeUserParts(text, images) });
    } else {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content });
        continue;
      }
      const text: string[] = [];
      const reasoning: string[] = [];
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      for (const block of msg.content) {
        if (block.type === "text") text.push(block.text);
        else if (block.type === "thinking") reasoning.push(block.thinking);
        else if (block.type === "tool_use")
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        // image / redacted_thinking / tool_result in an assistant message:
        // not representable in OpenAI's assistant shape — dropped.
      }
      const assistant: Record<string, unknown> = { role: "assistant" };
      if (text.length > 0) assistant.content = text.join("\n");
      else if (toolCalls.length === 0) assistant.content = "";
      // Round-trip prior reasoning so a multi-turn reasoning model (e.g.
      // DeepSeek reasoner over an OpenAI gateway) keeps its chain available.
      if (reasoning.length > 0) assistant.reasoning_content = reasoning.join("\n");
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      out.push(assistant);
    }
  }
  return out;
}

/** Build the full chat-completions params object exactly as it hits the wire. */
export function buildOpenAIRequestBody(
  req: ModelRequest,
  config: OpenAIModelConfig,
  framing: RequestFraming,
): ChatCompletionCreateParamsStreaming {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAIMessages(req.system, req.messages),
    max_tokens: framing.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (framing.tools.length > 0) {
    body.tools = framing.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  // The transport treats the profile's mapped thinking params opaquely and
  // merges them verbatim (e.g. `reasoning_effort`, `thinking: { type }`) —
  // including provider-specific fields the SDK's params type doesn't know.
  for (const [key, value] of Object.entries(framing.thinkingParams)) {
    body[key] = value;
  }
  return body as unknown as ChatCompletionCreateParamsStreaming;
}

// ────────────────────────────────────────────────────────────────────────────
// The streaming call
// ────────────────────────────────────────────────────────────────────────────

/** A `delta` widened with the Chinese gateways' reasoning extension. */
type StreamDelta = ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
  reasoning?: string | null;
};

/** A `usage` widened with the cache-hit extension (DeepSeek / Qwen). */
type StreamUsage = NonNullable<ChatCompletionChunk["usage"]> & {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

/**
 * One OpenAI-compatible request attempt: stream `chat.completions` through the
 * SDK, accumulate text / reasoning / tool calls, and return the fully-built
 * {@link AssistantTurn}. Live deltas ride the same `onStreamText` /
 * `onStreamProgress` callbacks as the Anthropic branch (UI throttles its own
 * rendering); output-token estimates count streamed chars against the profile's
 * `tokenEstimate`, and the real usage — when the final chunk carries it —
 * replaces the estimate in a last progress update and in the returned turn.
 *
 * Errors thrown here fall out to the shared retry loop: malformed tool-call
 * JSON surfaces as the raw `JSON.parse` `SyntaxError` (matched generically),
 * dropped sockets as SDK/transport errors (matched generically), and HTTP
 * failures as the SDK's `APIError` — which carries `status` / `headers` /
 * `error` in exactly the shape the profile error tables read, so `onError`
 * classifies it identically to the Anthropic branch's SDK errors.
 */
export async function openAIStreamOnce(
  req: ModelRequest,
  client: OpenAIClient,
  config: OpenAIModelConfig,
  framing: RequestFraming,
): Promise<AssistantTurn> {
  const provider = config.provider;
  if (!config.baseURL) {
    throw new Error(
      "OpenAI-compatible transport requires a `baseURL` — set one in nova.config.json " +
        "(e.g. https://dashscope.aliyuncs.com/compatible-mode/v1).",
    );
  }
  const body = buildOpenAIRequestBody(req, config, framing);

  // Per-request headers, NOT the client's defaultHeaders: the request level
  // wins over the SDK's own auth header, preserving the documented contract
  // that `settings.headers` may override even `authorization` (a gateway's
  // tenant/routing header, a non-standard key shape).
  const headers =
    config.headers && Object.keys(config.headers).length > 0 ? config.headers : undefined;
  const stream = await client.chat.completions.create(body, {
    ...(req.signal ? { signal: req.signal } : {}),
    ...(headers ? { headers } : {}),
  });

  // Accumulators, reset per attempt so a retry starts from zero.
  let text = "";
  let reasoning = "";
  const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();
  let finishReason: ChatCompletionChunk.Choice["finish_reason"] = null;
  let usage: StreamUsage | undefined;
  let inputTokens: number | undefined;
  let cjk = 0;
  let other = 0;
  const { cjk: cjkRate, other: otherRate } = provider.tokenEstimate;

  const onProgress = config.onStreamProgress;
  const onText = config.onStreamText;
  const bumpProgress = (chunk: string): void => {
    if (!onProgress) return;
    for (const ch of chunk) {
      if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk++;
      else other++;
    }
    onProgress({ inputTokens, outputTokens: Math.ceil(cjk * cjkRate + other * otherRate) });
  };

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as StreamDelta | undefined;
    if (delta) {
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        if (onText) onText({ text: delta.content });
        bumpProgress(delta.content);
      }
      const reason =
        typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : undefined;
      if (reason && reason.length > 0) {
        reasoning += reason;
        if (onText) onText({ thinking: reason });
        bumpProgress(reason);
      }
      const tcs = delta.tool_calls;
      if (tcs) {
        for (const tc of tcs) {
          const index = tc.index;
          const entry = toolCalls.get(index) ?? { args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          toolCalls.set(index, entry);
        }
      }
    }
    const choice = chunk.choices[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage as StreamUsage;
  }

  const content: ContentBlock[] = [];
  if (reasoning.length > 0) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (text.length > 0) content.push({ type: "text", text });
  const sorted = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, tc] of sorted) {
    if (!tc.id || !tc.name) continue; // truncated mid-call (e.g. max_tokens) — drop
    // A malformed arguments payload is a model hiccup, not an API failure: the
    // raw SyntaxError matches `isMalformedToolJsonError` and the shared retry
    // loop transparently re-issues the request.
    const input = JSON.parse(tc.args.length > 0 ? tc.args : "{}") as Record<string, unknown>;
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  const stopReason: StopReason =
    finishReason === "tool_calls" || finishReason === "function_call"
      ? "tool_use"
      : finishReason === "length"
        ? "max_tokens"
        : finishReason === "content_filter"
          ? "refusal"
          : "end_turn";

  const turn: AssistantTurn = { content, stopReason };
  if (usage) {
    // Bucket semantics must match the Anthropic branch's contract: `inputTokens`
    // is the NON-cached input, and the total prompt is the sum of all three
    // buckets (cost.ts and the context-usage meter both add them).
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? 0;
    const uncached = (usage.prompt_tokens ?? 0) - hit - miss;
    // Two bucket shapes exist among the gateways this transport serves:
    //
    // - Anthropic-style THREE buckets (uncached + hit + miss = prompt_tokens):
    //   `prompt_tokens` carries a real uncached remainder, and the hit/miss
    //   fields are subsets. Subtract them back out or the cache tokens get
    //   counted twice and the meter/cost inflate.
    //
    // - DeepSeek's TWO buckets: it reports `prompt_tokens == hit + miss` — its
    //   cache splits every input into "hit" or "miss" with no third "neither
    //   cached nor written" bucket, and the miss tokens are billed at the full
    //   input price (its models table sets cacheWrite = input, matching). The
    //   miss bucket IS the uncached input, so it lands in `inputTokens` — the
    //   same bucket the Anthropic wire's `input_tokens` lands in — rather than
    //   in `cacheCreationInputTokens`. Reporting it as "cache creation" zeroes
    //   the uncached bucket (every request showed a ~100% cache hit rate and
    //   `/usage`'s 未缓存 row read 0 forever) and makes the rate incomparable
    //   with the anthropic wire.
    const isTwoBucket = uncached <= 0;
    turn.usage = {
      inputTokens: isTwoBucket ? miss : uncached,
      outputTokens: usage.completion_tokens ?? 0,
      ...(usage.prompt_cache_hit_tokens !== undefined ? { cacheReadInputTokens: hit } : {}),
      // Only the three-bucket shape carries a separate cache-write bucket;
      // DeepSeek folds the write into `miss` and bills it at full price.
      ...(!isTwoBucket && usage.prompt_cache_miss_tokens !== undefined
        ? { cacheCreationInputTokens: miss }
        : {}),
    };
    // Real totals landed — one final progress update with them.
    if (onProgress)
      onProgress({ inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens });
  }
  return turn;
}
