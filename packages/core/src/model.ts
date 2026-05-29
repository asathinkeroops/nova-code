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

      const res = await client.messages.create(
        {
          model: config.model,
          max_tokens: maxTokens,
          system: req.system,
          messages: req.messages as Anthropic.MessageParam[],
          tools: tools as Anthropic.Tool[],
          ...thinkingParams,
        } as Anthropic.MessageCreateParamsNonStreaming,
        req.signal ? { signal: req.signal } : undefined,
      );

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
