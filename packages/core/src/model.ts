import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
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
   * too small the adapter auto-bumps it (budget + 4096) rather than failing.
   */
  thinkingBudgetTokens?: number;
}

export interface AnthropicModelConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
}

export function createAnthropicModel(config: AnthropicModelConfig): ModelClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

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
      const maxTokens = thinkingEnabled
        ? Math.max(req.maxTokens, budget + 4096)
        : req.maxTokens;

      const res = await client.messages.create(
        {
          model: config.model,
          max_tokens: maxTokens,
          system: req.system,
          messages: req.messages as Anthropic.MessageParam[],
          tools: tools as Anthropic.Tool[],
          ...(thinkingEnabled
            ? { thinking: { type: "enabled" as const, budget_tokens: budget } }
            : {}),
        },
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
