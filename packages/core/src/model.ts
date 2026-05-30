import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { THINKING_BUDGETS } from "./thinking.js";
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

/**
 * Wire format for the thinking knob.
 *
 * - `anthropic` — first-party Claude format: `thinking.budget_tokens`.
 * - `deepseek`  — DeepSeek's Anthropic-compatible endpoint: it accepts
 *   `thinking.type` but rejects `budget_tokens`, taking intensity via
 *   `output_config.effort` ("high" | "max") instead.
 */
export type ThinkingFormat = "anthropic" | "deepseek";

export interface AnthropicModelConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  /**
   * Live progress callback for this request. High-frequency and best-effort —
   * callers should throttle their own UI updates. The exact final numbers are
   * in the returned usage once the turn completes.
   */
  onStreamProgress?: (progress: StreamProgress) => void;
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

export function detectThinkingFormat(model: string): ThinkingFormat {
  return /deepseek/i.test(model) ? "deepseek" : "anthropic";
}

// DeepSeek only exposes "high" and "max". Anything below our `max` budget
// (32k tokens, see THINKING_BUDGETS) rounds to "high"; at-or-above rounds to
// "max" — matches DeepSeek's documented behavior where low/medium are
// rewritten to high on their side.
function budgetToEffort(budget: number): "high" | "max" {
  return budget >= THINKING_BUDGETS.max ? "max" : "high";
}

export function createAnthropicModel(config: AnthropicModelConfig): ModelClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
  const format = detectThinkingFormat(config.model);

  return {
    async call(req: ModelRequest): Promise<AssistantTurn> {
      const tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: zodToJsonSchema(t.inputSchema, {
          target: "jsonSchema7",
          $refStrategy: "none",
        }) as Record<string, unknown>,
      }));

      const budget = req.thinkingBudgetTokens ?? 0;
      const thinkingEnabled = budget > 0;
      // Anthropic requires max_tokens > budget_tokens; DeepSeek doesn't take a
      // budget so there's nothing to outgrow.
      const maxTokens =
        thinkingEnabled && format === "anthropic"
          ? Math.max(req.maxTokens, budget + 8192)
          : req.maxTokens;
      let thinkingParams: Record<string, unknown> = {};
      if (thinkingEnabled) {
        if (format === "deepseek") {
          thinkingParams = {
            thinking: { type: "enabled" as const },
            output_config: { effort: budgetToEffort(budget) },
          };
        } else {
          thinkingParams = {
            thinking: { type: "enabled" as const, budget_tokens: budget },
          };
        }
      } else {
        thinkingParams = {
          thinking: { type: "disabled" },
        };
      }

      // Stream rather than buffer the full response. A long non-streaming
      // generation holds one connection open for the whole turn, which gateways
      // and proxies love to reset mid-body (read ECONNRESET while decompressing
      // the gzip payload). Streaming keeps the socket active and lets the SDK
      // accumulate the same final Message via `finalMessage()`.
      const stream = client.messages.stream(
        {
          model: config.model,
          max_tokens: maxTokens,
          system: req.system,
          messages: req.messages as Anthropic.MessageParam[],
          tools: tools as Anthropic.Tool[],
          ...thinkingParams,
        } as Anthropic.MessageStreamParams,
        req.signal ? { signal: req.signal } : undefined,
      );
      if (config.onStreamProgress) {
        const onProgress = config.onStreamProgress;
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
          const delta = event.delta as { text?: string; partial_json?: string; thinking?: string };
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
          onProgress({ inputTokens, outputTokens: Math.ceil(cjk * 0.6 + other / 4) });
        });
      }
      const res = await stream.finalMessage();

      const content = res.content as ContentBlock[];
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
