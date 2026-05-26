import { MAGENTA_RGB, magenta } from "./colors.js";
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
 * Wire the CLI's screen / spinner / footer to the agent's lifecycle by
 * registering one advisory hook per point.
 *
 * Each hook is best-effort (errors swallowed by `HookRegistry`); transcript
 * and persist are owned by the agent itself, so nothing here touches disk.
 */
export function registerUiHooks(ctx: CliContext): void {
  ctx.agent.on("post_messages", ({ messages }) => {
    ctx.screen.setMessages(messages);
    ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
    refreshTodoFooter(ctx);
  });

  ctx.agent.on("post_compact", () => {
    // Inline cards anchored to pre-compaction message indices are meaningless
    // now — drop them all rather than try to rebase.
    ctx.screen.clearCards();
    const notice = ctx.pendingAutoCompactNotice;
    ctx.pendingAutoCompactNotice = null;
    if (notice) {
      const tail = notice.transcriptPath ? `\nsnapshot: ${notice.transcriptPath}` : "";
      ctx.screen.card(`history ${notice.before} → ${notice.after} msgs${tail}`, {
        kind: "info",
        title: "auto-compact",
      });
    }
  });

  // `pre_request` is blocking — returning undefined keeps it advisory for us.
  ctx.agent.on("pre_request", () => {
    ctx.spinner = ctx.screen.startSpinner(
      { words: WORKING_WORDS, tint: MAGENTA_RGB, colorize: magenta },
      "esc to interrupt",
    );
  });

  ctx.agent.on("post_request", ({ durationMs, error }) => {
    if (error) {
      const seconds = (durationMs / 1000).toFixed(1);
      const word = ctx.spinner?.label() ?? "working";
      stopSpinner(ctx);
      ctx.screen.card(`${word} · ${seconds}s · ${error}`, {
        kind: "error",
        title: "request failed",
      });
    } else {
      stopSpinner(ctx);
    }
  });

  ctx.agent.on("pre_permission", () => clearToolSpinner(ctx));
  ctx.agent.on("post_permission", ({ granted }) => {
    if (granted) armToolSpinner(ctx);
  });
  // `post_tool_use` is blocking; advisory subscribers just arm/clear and
  // return undefined.
  ctx.agent.on("post_tool_use", () => {
    clearToolSpinner(ctx);
  });

  ctx.agent.on("post_turn", () => {
    stopSpinner(ctx);
    refreshTodoFooter(ctx);
  });

  ctx.agent.on("error", ({ message }) => {
    stopSpinner(ctx);
    ctx.screen.card(`${message}\nsee log: ${ctx.logPath}`, {
      kind: "error",
      title: "loop terminated",
    });
  });
}
