import type { ToolContext, ToolExecutor, ToolResultBlock, ToolUseBlock } from "@nova/core";
import type { Logger } from "@nova/runtime";
import type { ToolRegistry } from "./registry.js";

export interface DispatcherDeps {
  registry: ToolRegistry;
  logger?: Logger;
}

export function createDispatcher(deps: DispatcherDeps): ToolExecutor {
  const { registry, logger } = deps;

  return async function dispatch(
    use: ToolUseBlock,
    ctx: ToolContext,
  ): Promise<ToolResultBlock> {
    logger?.debug({ tool: use.name, id: use.id }, "tool dispatched");

    const errorResult = (content: string): ToolResultBlock => ({
      type: "tool_result",
      tool_use_id: use.id,
      content,
      is_error: true,
    });

    const handler = registry.get(use.name);
    if (!handler) {
      return errorResult(`Tool not found: ${use.name}`);
    }

    const parsed = handler.definition.inputSchema.safeParse(use.input);
    if (!parsed.success) {
      return errorResult(`Invalid input for tool ${use.name}: ${parsed.error.message}`);
    }

    try {
      const result = await handler.run(parsed.data, ctx);
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content: result.output,
        ...(result.isError ? { is_error: true } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.error({ tool: use.name, err: msg }, "tool execution failed");
      return errorResult(`Tool error: ${msg}`);
    }
  };
}
