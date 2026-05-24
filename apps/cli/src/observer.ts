import type { LoopObserver, MessageParam } from "@nova/core";
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

/**
 * The CLI observer is now purely a side-channel: it manages spinners and the
 * permission/tool-execution state machine, refreshes the todo footer, and
 * appends to transcript and log. **It does not print conversation content** —
 * the `<Messages>` component is the only renderer of assistant text, thinking,
 * tool_use, and tool_result. The loop's `messages_changed` event keeps the
 * store in sync with `agentLoop`'s internal `messages` array.
 */
export function createObserver(ctx: CliContext): LoopObserver {
  return async (event) => {
    // `messages_changed` is a UI-sync event; persisting it would duplicate
    // every per-turn mutation that's already captured by assistant/user/
    // interject records.
    if (!ctx.noTranscript && event.kind !== "messages_changed") {
      await ctx.transcript.append({
        kind: event.kind,
        turn: event.turn,
        data: event.payload,
      });
    }
    if (event.kind === "messages_changed") {
      const p = event.payload as { messages: MessageParam[] };
      ctx.screen.setMessages(p.messages);
      // Keep the thinking label in sync so historical thinking blocks render
      // with the level that was active when they were generated. (We only have
      // a single "current" label; this matches the prior behavior.)
      ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
      // The todoStore is mutated by todo tools between tool_use and
      // tool_result; by the time messages_changed fires for the tool_results
      // batch, all mutations have landed. One refresh per event is enough.
      refreshTodoFooter(ctx);
      return;
    }
    if (event.kind === "compact_end") {
      // Inline cards anchored to pre-compaction message indices are now
      // meaningless — drop them all rather than try to rebase.
      ctx.screen.clearCards();
      return;
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
    } else if (event.kind === "tool_use") {
      const use = event.payload as { id: string; name: string; input: Record<string, unknown> };
      ctx.logger.info({ tool: use.name, input: use.input }, "→ tool_use");
      // No-permission-gate path: if no permission_start follows, this timer
      // is what shows the running indicator. permission_start (if any) will
      // cancel it before the interactive prompt opens.
      armToolSpinner(ctx);
    } else if (event.kind === "permission_start") {
      // Entering interactive permission phase — kill any pending/running tool
      // spinner so it does not contend with the prompt UI.
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
      const r = event.payload as { tool_use_id: string; is_error?: boolean };
      ctx.logger.info({ toolUseId: r.tool_use_id, isError: r.is_error ?? false }, "← tool_result");
      // The loop emits a `messages_changed` immediately after this event with
      // the result committed into the canonical message stream — Messages will
      // flip the paired tool_use to "done" without any extra side state here.
    }
  };
}
