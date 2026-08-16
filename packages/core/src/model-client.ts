import { zodToJsonSchema } from "zod-to-json-schema";
import type { AssistantTurn, MessageParam, ToolDefinition } from "./types.js";

/**
 * The model transport, as the loop sees it. core declares the contract and
 * never implements it — the Anthropic-compatible adapter, the provider profiles
 * and the retry policy all live in `@nova/model`, so this package imports no
 * model SDK. Same pattern as `SandboxBridge` and `InvariantsCheck`.
 */
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
   * When > 0, enables extended thinking with the given token budget. Providers
   * that require `max_tokens > budget_tokens` bump it themselves rather than
   * failing.
   */
  thinkingBudgetTokens?: number;
}

/** A tool serialized to the exact wire shape sent to the model. */
export interface WireTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Serialized form per tool definition. Definitions are stable objects (the
 * registry hands back the same ones every call), so the zod → JSON Schema
 * conversion below runs once per tool instead of once per model call — it was
 * re-deriving every schema on every request, including each sub-agent's. Keyed
 * weakly so re-registered tools (an MCP server reconnecting) don't accumulate.
 */
const wireToolCache = new WeakMap<ToolDefinition, WireTool>();

/**
 * Serialize tool definitions to the `tools` payload sent to the model: each
 * tool's `input_schema` is its `inputJsonSchema` when present (MCP servers
 * publish native JSON Schema) or derived from its zod `inputSchema` otherwise.
 * Exported so callers can size the tool schemas against the exact bytes the
 * model receives — the CLI's `/context` breakdown estimates this way.
 */
export function toWireTools(tools: ToolDefinition[]): WireTool[] {
  return tools.map((t) => {
    const hit = wireToolCache.get(t);
    if (hit) return hit;
    const wire: WireTool = {
      name: t.name,
      description: t.description,
      input_schema: (t.inputJsonSchema ??
        zodToJsonSchema(t.inputSchema, {
          target: "jsonSchema7",
          $refStrategy: "none",
        })) as Record<string, unknown>,
    };
    wireToolCache.set(t, wire);
    return wire;
  });
}
