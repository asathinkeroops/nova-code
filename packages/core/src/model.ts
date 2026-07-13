import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { type ProviderProfile } from "./providers/index.js";
import {
  RETRY_LIMITS,
  backoffMs,
  isMalformedToolJsonError,
  isTransientNetworkError,
} from "./retry.js";
import { toWireMessages } from "./messages.js";
import type {
  AssistantTurn,
  ContentBlock,
  MessageParam,
  StopReason,
  ToolDefinition,
} from "./types.js";

export interface ModelClient {
  call(req: ModelRequest): Promise<AssistantTurn>;
}

export interface ModelRequest {
  system: string;
  messages: MessageParam[];
  tools: ToolDefinition[];
  maxTokens: number;
  signal?: AbortSignal;
  /**
   * When > 0, enables extended thinking with the given token budget. Anthropic
   * requires `max_tokens > budget_tokens`; if the configured `maxTokens` is
   * too small the adapter auto-bumps it (budget + 8192) rather than failing.
   */
  thinkingBudgetTokens?: number;
}

export interface AnthropicModelConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  /**
   * Provider profile driving thinking-param and error/retry behavior. Required:
   * the caller resolves it once from `settings.provider` (see `resolveProfile`)
   * and passes a concrete profile — the adapter never guesses from the model name.
   */
  provider: ProviderProfile;
  /**
   * Live progress callback for this request. High-frequency and best-effort —
   * callers should throttle their own UI updates. The exact final numbers are
   * in the returned usage once the turn completes.
   */
  onStreamProgress?: (progress: StreamProgress) => void;
  /**
   * Live assistant content as it streams, delta by delta — `text` for the
   * visible answer, `thinking` for reasoning. High-frequency and best-effort;
   * callers should accumulate and throttle their own rendering. Emitted only
   * for this request and superseded by the final message once the turn lands.
   */
  onStreamText?: (delta: StreamTextDelta) => void;
  /**
   * Notified before each automatic retry of a transient DeepSeek failure
   * (429/500/503). Best-effort and DeepSeek-only — other models never retry
   * internally. Lets the UI show "retrying (2/4)…" without coupling the adapter
   * to a logger.
   */
  onRetry?: (info: RetryNotice) => void;
}

export interface RetryNotice {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Total attempts the adapter will make before giving up. */
  maxAttempts: number;
  /** Milliseconds the adapter will wait before the next attempt. */
  delayMs: number;
  /**
   * The DeepSeek HTTP status that triggered the retry. Absent for non-HTTP
   * retries (see `reason`).
   */
  status?: number;
  /**
   * Machine-readable cause when the retry wasn't an HTTP error:
   * - "malformed-json": the model streamed unparseable tool-call arguments.
   * - "network": a transient transport failure (e.g. read ECONNRESET, socket
   *   hang up) dropped the connection before the response completed.
   */
  reason?: "malformed-json" | "network";
}

export interface StreamTextDelta {
  /** Incremental visible answer text, if this chunk carried any. */
  text?: string;
  /** Incremental reasoning text, if this chunk carried any. */
  thinking?: string;
}

export interface StreamProgress {
  /**
   * Real "uploaded" prompt tokens for this request — input + cache read + cache
   * creation — read from the `message_start` usage. Present once that event
   * arrives; some gateways omit it, in which case it stays undefined.
   */
  inputTokens?: number;
  /**
   * *Estimate* of the output tokens generated so far this request. Real
   * output_tokens only lands at end-of-stream, so a live counter must
   * approximate from the streamed text.
   */
  outputTokens: number;
}

/**
 * Wait `ms`, but bail out early if `signal` aborts — rejecting with the abort
 * reason so an interrupt during a retry backoff propagates as a cancellation
 * rather than silently sleeping it out.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A tool serialized to the exact wire shape sent to the model. */
export interface WireTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Serialize tool definitions to the `tools` payload sent to the model: each
 * tool's `input_schema` is its `inputJsonSchema` when present (MCP servers
 * publish native JSON Schema) or derived from its zod `inputSchema` otherwise.
 * Exported so callers can size the tool schemas against the exact bytes the
 * model receives — the CLI's `/context` breakdown estimates this way.
 */
export function toWireTools(tools: ToolDefinition[]): WireTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.inputJsonSchema ??
      zodToJsonSchema(t.inputSchema, {
        target: "jsonSchema7",
        $refStrategy: "none",
      })) as Record<string, unknown>,
  }));
}

export function createAnthropicModel(config: AnthropicModelConfig): ModelClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
  const provider = config.provider;

  return {
    async call(req: ModelRequest): Promise<AssistantTurn> {
      const tools = toWireTools(req.tools);

      const budget = req.thinkingBudgetTokens ?? 0;
      // The provider owns the thinking-knob wire shape and any max_tokens floor
      // it imposes (Anthropic needs max_tokens > budget_tokens; DeepSeek doesn't).
      const { params: thinkingParams, minMaxTokens } = provider.thinking(budget);
      const maxTokens = minMaxTokens ? Math.max(req.maxTokens, minMaxTokens) : req.maxTokens;

      // Stream rather than buffer the full response. A long non-streaming
      // generation holds one connection open for the whole turn, which gateways
      // and proxies love to reset mid-body (read ECONNRESET while decompressing
      // the gzip payload). Streaming keeps the socket active and lets the SDK
      // accumulate the same final Message via `finalMessage()`.
      //
      // One attempt = build the stream, wire live-progress listeners (fresh
      // per attempt so token counters don't carry over a retry), await the
      // final message.
      const streamOnce = async (): Promise<{
        message: Anthropic.Message;
        thinkingText: string;
      }> => {
        const stream = client.messages.stream(
          {
            model: config.model,
            max_tokens: maxTokens,
            system: req.system,
            // Strip nova-internal fields (notably `meta`) so the wire body stays
            // byte-identical to the pre-`meta` format — preserves the prefix cache.
            messages: toWireMessages(req.messages) as Anthropic.MessageParam[],
            tools: tools as Anthropic.Tool[],
            ...thinkingParams,
          } as Anthropic.MessageStreamParams,
          req.signal ? { signal: req.signal } : undefined,
        );
        const onProgress = config.onStreamProgress;
        const onText = config.onStreamText;
        // Accumulate streamed reasoning so we can backfill it into the final
        // message. DeepSeek surfaces thinking via `content_block_delta` (shown
        // live), but `finalMessage()` reconstructs an EMPTY thinking block —
        // so the committed/persisted turn loses the reasoning unless we re-attach
        // it here. Accumulated unconditionally (not gated on the UI callbacks).
        let thinkingText = "";
        // Uploaded prompt tokens are a real count carried by `message_start`;
        // captured once and replayed with every subsequent update.
        //
        // Output tokens, by contrast, only arrive (for real) in the final
        // message_delta — DeepSeek and Anthropic both withhold them mid-stream —
        // so a *live* counter estimates from the text as it streams in: ~4
        // chars/token for latin, ~0.6 token/char for CJK. Accumulated
        // incrementally from each delta so it stays O(total chars), not O(n²).
        let inputTokens: number | undefined;
        let cjk = 0;
        let other = 0;
        stream.on("streamEvent", (event) => {
          if (event.type === "message_start") {
            if (!onProgress) return;
            const u = event.message.usage as {
              input_tokens?: number;
              cache_read_input_tokens?: number | null;
              cache_creation_input_tokens?: number | null;
            };
            inputTokens =
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0);
            onProgress({ inputTokens, outputTokens: 0 });
            return;
          }
          if (event.type !== "content_block_delta") return;
          const delta = event.delta as {
            text?: string;
            partial_json?: string;
            thinking?: string;
          };
          if (delta.thinking !== undefined) thinkingText += delta.thinking;
          // Stream the visible answer / reasoning to the UI as it arrives.
          // `partial_json` (tool-call arguments) is deliberately excluded —
          // it isn't readable prose and lands in the final message anyway.
          if (onText && (delta.text !== undefined || delta.thinking !== undefined)) {
            onText({
              ...(delta.text !== undefined ? { text: delta.text } : {}),
              ...(delta.thinking !== undefined ? { thinking: delta.thinking } : {}),
            });
          }
          if (!onProgress) return;
          const chunk = delta.text ?? delta.partial_json ?? delta.thinking ?? "";
          for (const ch of chunk) {
            const c = ch.codePointAt(0) ?? 0;
            if (
              (c >= 0x4e00 && c <= 0x9fff) || // CJK ideographs
              (c >= 0x3040 && c <= 0x30ff) || // kana
              (c >= 0xac00 && c <= 0xd7a3) // hangul
            ) {
              cjk++;
            } else {
              other++;
            }
          }
          onProgress({ inputTokens, outputTokens: Math.ceil(cjk * 0.6 + other * 0.3) });
        });
        const message = await stream.finalMessage();
        return { message, thinkingText };
      };

      // Three error classes are retried here with backoff:
      //   1. Malformed tool-call JSON the SDK chokes on while accumulating the
      //      stream — a model hiccup (any provider), not an API failure, so it
      //      carries no status. Handled generically, before the provider.
      //   2. Transient network/transport failures (read ECONNRESET, socket hang
      //      up, DNS blip) — the connection dropped before the response landed,
      //      independent of any provider, and carries no HTTP status either. Also
      //      handled generically before the provider, so every profile (not just
      //      DeepSeek's status table) recovers from a reset socket instead of
      //      failing the whole turn or sub-agent on the first blip.
      //   3. Provider-classified API failures — the profile decides whether a
      //      given error is a transient it wants retried, and what final error to
      //      surface otherwise (e.g. DeepSeek's translated diagnostics).
      const maxAttempts = RETRY_LIMITS.maxAttempts;
      let res: Anthropic.Message;
      let streamedThinking = "";
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          const out = await streamOnce();
          res = out.message;
          streamedThinking = out.thinkingText;
          break;
        } catch (err) {
          const canRetry = attempt < maxAttempts && !req.signal?.aborted;
          if (canRetry && isMalformedToolJsonError(err)) {
            const delayMs = backoffMs(attempt);
            config.onRetry?.({ attempt, maxAttempts, delayMs, reason: "malformed-json" });
            await sleep(delayMs, req.signal);
            continue;
          }
          if (canRetry && isTransientNetworkError(err)) {
            const delayMs = backoffMs(attempt);
            config.onRetry?.({ attempt, maxAttempts, delayMs, reason: "network" });
            await sleep(delayMs, req.signal);
            continue;
          }
          const decision = provider.onError(err, attempt);
          if (canRetry && decision.retry) {
            config.onRetry?.({
              attempt,
              maxAttempts,
              delayMs: decision.delayMs,
              ...(decision.status !== undefined ? { status: decision.status } : {}),
            });
            await sleep(decision.delayMs, req.signal);
            continue;
          }
          throw decision.error;
        }
      }

      const content = res.content as ContentBlock[];
      // Re-attach reasoning the stream surfaced but `finalMessage()` dropped.
      // Only fill a thinking block whose text is empty — never clobber one that
      // already carries reasoning (Anthropic populates these, signature and all).
      if (streamedThinking.length > 0) {
        const empty = content.find(
          (b): b is Extract<ContentBlock, { type: "thinking" }> =>
            b.type === "thinking" && b.thinking.trim().length === 0,
        );
        if (empty) empty.thinking = streamedThinking;
      }
      const stopReason = (res.stop_reason ?? "end_turn") as StopReason;
      const u = res.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
      return {
        content,
        stopReason,
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadInputTokens: u.cache_read_input_tokens ?? undefined,
          cacheCreationInputTokens: u.cache_creation_input_tokens ?? undefined,
        },
      };
    },
  };
}
