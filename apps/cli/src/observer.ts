import {
  blocksOf,
  extractText,
  type LoopObserver,
  type MessageParam,
} from "@nova/core";
import { MAGENTA_RGB, magenta, red } from "./colors.js";
import { WORKING_WORDS } from "./constants.js";
import {
  armToolSpinner,
  clearToolSpinner,
  refreshTodoFooter,
  stopSpinner,
  thinkingLevelLabel,
  type CliContext,
} from "./context.js";
import { renderMarkdown } from "./markdown.js";
import {
  renderRedactedThinking,
  renderThinking,
  renderToolResult,
  renderToolUse,
} from "./renderers.js";

/**
 * Todo tools are bookkeeping for the agent; the user already sees the
 * resulting list in the footer, so suppress their tool_use/tool_result UI.
 */
function isTodoTool(name: string | undefined): boolean {
  return name === "createTodo" || name === "updateTodo" || name === "getTodos";
}

export function createObserver(ctx: CliContext): LoopObserver {
  return async (event) => {
    if (!ctx.noTranscript) {
      await ctx.transcript.append({
        kind: event.kind,
        turn: event.turn,
        data: event.payload,
      });
    }
    if (event.kind === "request_start") {
      ctx.spinner = ctx.screen.startSpinner(
        { words: WORKING_WORDS, tint: MAGENTA_RGB, colorize: magenta },
        "esc to interrupt",
      );
    } else if (event.kind === "request_end") {
      const p = event.payload as { durationMs: number; error?: string };
      if (p.error) {
        const seconds = (p.durationMs / 1000).toFixed(1);
        const word = ctx.spinner?.label() ?? "working";
        stopSpinner(ctx, red(`✗ ${word} · ${seconds}s · ${p.error}`));
      } else {
        stopSpinner(ctx);
      }
    } else if (event.kind === "assistant") {
      const blocks = blocksOf(event.payload as MessageParam);
      const levelLabel = thinkingLevelLabel(ctx);
      for (const block of blocks) {
        if (block.type === "thinking") {
          ctx.screen.print(`\n${renderThinking(block.thinking, levelLabel)}\n`);
        } else if (block.type === "redacted_thinking") {
          ctx.screen.print(`\n${renderRedactedThinking(levelLabel)}\n`);
        }
      }
      const text = extractText(blocks);
      if (text.trim().length > 0) {
        ctx.screen.print(`\n${renderMarkdown(text)}\n`);
      }
    } else if (event.kind === "tool_use") {
      const use = event.payload as { id: string; name: string; input: Record<string, unknown> };
      ctx.pendingUses.set(use.id, { name: use.name, input: use.input });
      ctx.logger.info({ tool: use.name, input: use.input }, "→ tool_use");
      if (!isTodoTool(use.name)) {
        ctx.screen.print(`\n${renderToolUse(use)}\n`);
        // No-permission-gate path: if no permission_start follows, this timer
        // is what shows the running indicator. permission_start (if any) will
        // cancel it before the interactive prompt opens.
        armToolSpinner(ctx);
      }
    } else if (event.kind === "permission_start") {
      // Entering interactive permission phase — kill any pending/running
      // tool spinner so it does not contend with the prompt UI.
      clearToolSpinner(ctx);
    } else if (event.kind === "permission_end") {
      const p = event.payload as { tool: string; granted: boolean };
      if (p.granted) {
        // Re-arm for the actual execution phase.
        armToolSpinner(ctx);
      }
      // If denied, tool_result follows immediately; no spinner needed.
    } else if (event.kind === "tool_result") {
      clearToolSpinner(ctx);
      const r = event.payload as { tool_use_id: string; is_error?: boolean; content: unknown };
      const pending = ctx.pendingUses.get(r.tool_use_id);
      if (pending) ctx.pendingUses.delete(r.tool_use_id);
      ctx.logger.info({ tool: pending?.name, isError: r.is_error ?? false }, "← tool_result");
      if (!isTodoTool(pending?.name)) {
        ctx.screen.print(`${renderToolResult(pending?.name, r, pending?.input)}\n`);
      }
      if (pending?.name === "createTodo" || pending?.name === "updateTodo") {
        refreshTodoFooter(ctx);
      }
    } else if (event.kind === "compact") {
      const p = event.payload as { from: number; to: number };
      ctx.logger.debug({ from: p.from, to: p.to }, "compact applied");
    }
  };
}
