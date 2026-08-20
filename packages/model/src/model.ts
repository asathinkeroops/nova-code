import Anthropic from "@anthropic-ai/sdk";
import { toWireMessages, toWireTools, type ModelClient, type ModelRequest } from "@nova/core";
import { isCjkCodePoint } from "@nova/base";
import { type ProviderProfile } from "./providers/index.js";
import {
  RETRY_LIMITS,
  backoffMs,
  isMalformedToolJsonError,
  isTransientNetworkError,
} from "./retry.js";
import type { AssistantTurn, ContentBlock, StopReason } from "@nova/core";
import type { ModelTransport } from "./providers/index.js";
import { openAIStreamOnce, createOpenAIClient, type OpenAIClient } from "./openai.js";

export interface ModelConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  /**
   * Extra HTTP headers merged into every request this client makes (a custom
   * `User-Agent`, a gateway's tenant/routing header). Handed to the Anthropic
   * SDK as `defaultHeaders` (or passed to the OpenAI SDK per-request), so an
   * entry here overrides the SDK's own value for that name — auth headers
   * included. Comes from `settings.headers`; the CLI validates names/values at
   * config load.
   */
  headers?: Record<string, string>;
  /**
   * Provider profile driving default transport, thinking-param and
   * error/retry behavior. Required: the caller resolves it once from
   * `settings.provider` (see `resolveProfile`) and passes a concrete profile —
   * the adapter never guesses from the model name.
   */
  provider: ProviderProfile;
  /**
   * Wire protocol override, when the caller wants to differ from the profile's
   * default transport. Comes from `settings.transport`. A vendor that ships
   * both endpoints (DeepSeek: `/anthropic` and the plain OpenAI-compatible
   * `https://api.deepseek.com`) keeps ONE profile and switches wires here.
   * The thinking knob is transport-sensitive — the profile returns the wire
   * shape for the EFFECTIVE transport (e.g. DeepSeek's `effort` exists only on
   * its Anthropic endpoint).
   */
  transport?: ModelTransport;
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
   * Notified before each automatic retry of a transient failure
   * (429/500/503, a reset socket, malformed tool-call JSON). Best-effort —
   * lets the UI show "retrying (2/4)…" without coupling the adapter to a
   * logger.
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
   * The HTTP status that triggered the retry. Absent for non-HTTP retries
   * (see `reason`).
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
   * creation. On the Anthropic branch it arrives with `message_start`; on the
   * OpenAI branch it is only known once the final chunk's `usage` lands, so
   * live updates carry `undefined` and the last update carries the real count.
   * Some gateways omit it entirely, in which case it stays undefined.
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

/**
 * Create a model client for the profile's wire protocol. The EFFECTIVE
 * transport is `config.transport` (from `settings.transport`) falling back to
 * the profile's `transport` default, falling back to "anthropic". "anthropic"
 * goes through the `@anthropic-ai/sdk` client; "openai" goes through the
 * OpenAI-compatible `chat/completions` transport (`openai.ts`, official
 * `openai` SDK). Both branches share one retry loop and the same
 * provider-owned thinking/error policy, so switching a provider's wire
 * protocol changes nothing above this call — and a vendor shipping both
 * endpoints (DeepSeek) needs no second profile.
 */
export function createModel(config: ModelConfig): ModelClient {
  const provider = config.provider;
  const transport: ModelTransport = config.transport ?? provider.transport ?? "anthropic";

  // Built eagerly (matching the pre-transport behavior): the SDK clients are
  // cheap to construct and the CLI builds a client per model, so surfacing a
  // bad baseURL/header config at construction beats a first-request surprise.
  // The branch that is NOT taken builds nothing (no unused client).
  const anthropicClient =
    transport === "openai"
      ? null
      : new Anthropic({
          apiKey: config.apiKey,
          ...(config.baseURL ? { baseURL: config.baseURL } : {}),
          ...(config.headers && Object.keys(config.headers).length > 0
            ? { defaultHeaders: config.headers }
            : {}),
        });
  const openaiClient: OpenAIClient | null =
    transport === "openai" ? createOpenAIClient(config) : null;

  return {
    async call(req: ModelRequest): Promise<AssistantTurn> {
      const budget = req.thinkingBudgetTokens ?? 0;
      // The provider owns the thinking-knob wire shape for the EFFECTIVE
      // transport (Anthropic `thinking.budget_tokens`, DeepSeek's effort on
      // its anthropic wire — and no knob at all on the openai wire) plus any
      // max_tokens floor the shape imposes (Anthropic needs
      // max_tokens > budget_tokens; the OpenAI-family knobs don't).
      const { params: thinkingParams, minMaxTokens } = provider.thinking(
        budget,
        config.model,
        transport,
      );
      const maxTokens = minMaxTokens ? Math.max(req.maxTokens, minMaxTokens) : req.maxTokens;

      // One attempt = run the effective transport's branch once. The branch
      // streams (keeping the socket active against gateway resets) and returns
      // the fully-built turn; errors fall out to the shared retry loop below.
      const framing = {
        maxTokens,
        thinkingParams,
        tools: toWireTools(req.tools),
      };
      const streamOnce =
        transport === "openai"
          ? () => openAIStreamOnce(req, openaiClient!, config, framing)
          : anthropicStreamOnce(config, req, maxTokens, thinkingParams, anthropicClient!);

      // Three error classes are retried here with backoff:
      //   1. Malformed tool-call JSON the stream-accumulation chokes on — a
      //      model hiccup (any provider), not an API failure, so it carries no
      //      status. Handled generically, before the provider.
      //   2. Transient network/transport failures (read ECONNRESET, socket
      //      hang up, DNS blip) — the connection dropped before the response
      //      landed, independent of any provider, and carries no HTTP status
      //      either. Also handled generically before the provider, so every
      //      profile (not just DeepSeek's status table) recovers from a reset
      //      socket instead of failing the whole turn or sub-agent on the
      //      first blip.
      //   3. Provider-classified API failures — the profile decides whether a
      //      given error is a transient it wants retried, and what final error
      //      to surface otherwise (e.g. DeepSeek's translated diagnostics).
      const maxAttempts = RETRY_LIMITS.maxAttempts;
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          return await streamOnce();
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
              ...(decision.error.status !== undefined ? { status: decision.error.status } : {}),
            });
            await sleep(decision.delayMs, req.signal);
            continue;
          }
          throw decision.error;
        }
      }
    },
  };
}

/**
 * The Anthropic-compatible branch. Streams rather than buffers the full
 * response: a long non-streaming generation holds one connection open for the
 * whole turn, which gateways and proxies love to reset mid-body (read
 * ECONNRESET while decompressing the gzip payload). Streaming keeps the socket
 * active and lets the SDK accumulate the same final Message via
 * `finalMessage()`.
 */
function anthropicStreamOnce(
  config: ModelConfig,
  req: ModelRequest,
  maxTokens: number,
  thinkingParams: ReturnType<ProviderProfile["thinking"]>["params"],
  client: Anthropic,
): () => Promise<AssistantTurn> {
  const provider = config.provider;
  const tools = toWireTools(req.tools);

  return async (): Promise<AssistantTurn> => {
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
        if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk++;
        else other++;
      }
      const { cjk: cjkRate, other: otherRate } = provider.tokenEstimate;
      onProgress({ inputTokens, outputTokens: Math.ceil(cjk * cjkRate + other * otherRate) });
    });
    const message = await stream.finalMessage();

    const content = message.content as ContentBlock[];
    // Re-attach reasoning the stream surfaced but `finalMessage()` dropped.
    // Only fill a thinking block whose text is empty — never clobber one that
    // already carries reasoning (Anthropic populates these, signature and all).
    if (thinkingText.length > 0) {
      const empty = content.find(
        (b): b is Extract<ContentBlock, { type: "thinking" }> =>
          b.type === "thinking" && b.thinking.trim().length === 0,
      );
      if (empty) empty.thinking = thinkingText;
    }
    const stopReason = (message.stop_reason ?? "end_turn") as StopReason;
    const u = message.usage as {
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
  };
}
