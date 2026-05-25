import type { ToolContext, ToolExecutor, ToolResultBlock, ToolUseBlock } from "@nova/core";
import type { Logger } from "@nova/runtime";
import type { InvariantsCheck } from "./invariants.js";
import type { ToolRegistry } from "./registry.js";

export interface DispatcherDeps {
  registry: ToolRegistry;
  logger?: Logger;
  /**
   * Optional invariants layer. When set, preCheck runs after schema validation
   * but before `handler.run`; a violation short-circuits to an `is_error`
   * tool_result (model-readable). postCommit runs after a successful run so
   * the ledger can record fresh mtime baselines.
   */
  invariants?: InvariantsCheck;
}

export function createDispatcher(deps: DispatcherDeps): ToolExecutor {
  const { registry, logger, invariants } = deps;

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

    if (invariants) {
      const check = await invariants.preCheck(use, ctx);
      if (!check.ok) {
        logger?.warn({ tool: use.name, reason: check.message }, "invariant violation");
        return errorResult(check.message);
      }
    }

    try {
      const result = await handler.run(parsed.data, ctx);
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: use.id,
        content: result.output,
        ...(result.isError ? { is_error: true } : {}),
      };
      if (invariants) {
        try {
          await invariants.postCommit(use, ctx, Boolean(result.isError));
        } catch (err) {
          // Ledger bookkeeping should never break the tool result the model
          // sees. Log and move on.
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn({ tool: use.name, err: msg }, "invariants postCommit failed");
        }
      }
      return block;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.error({ tool: use.name, err: msg }, "tool execution failed");
      return errorResult(`Tool error: ${msg}`);
    }
  };
}
