import type { ToolContext, ToolExecutor, ToolResultBlock, ToolUseBlock } from "@nova/core";
import type { Logger } from "@nova/runtime";
import type { ZodError } from "zod";
import type { InvariantsCheck } from "./invariants.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Flatten a zod validation failure into a terse, model-readable line.
 *
 * The default `ZodError.message` is a JSON dump of the issue array — the
 * actionable signal (which field, why) is buried, so the model rarely
 * self-corrects. We surface each issue as `<path>: <reason>` and special-case
 * the most common failure (a missing required field, which zod reports as
 * `invalid_type` with `received: "undefined"` and the unhelpful message
 * "Required") into an explicit "is required" hint.
 */
export function formatValidationError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "input";
      if (issue.code === "invalid_type" && issue.received === "undefined") {
        return `${at} is required (expected ${issue.expected})`;
      }
      return `${at}: ${issue.message}`;
    })
    .join("; ");
}

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
      return errorResult(
        `Invalid input for tool ${use.name}: ${formatValidationError(parsed.error)}`,
      );
    }

    if (invariants) {
      const check = await invariants.preCheck(use, ctx);
      if (!check.ok) {
        logger?.warn({ tool: use.name, reason: check.message }, "invariant violation");
        return errorResult(check.message);
      }
    }

    try {
      const result = await handler.run(parsed.data, { ...ctx, toolUseId: use.id });
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
