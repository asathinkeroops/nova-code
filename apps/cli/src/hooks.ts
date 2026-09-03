import { t } from "./i18n/index.js";
import {
  refreshTaskFooter,
  refreshTodoFooter,
  scheduleTaskAutoClear,
  scheduleTodoAutoClear,
  startWorkingSpinner,
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
    // The committed messages now contain whatever was streaming, so drop the
    // live draft in the same tick — React batches both into one frame, so the
    // streamed text is replaced by the final render with no flicker.
    ctx.resetLiveStream();
    ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
    refreshTodoFooter(ctx);
    void refreshTaskFooter(ctx);
  });

  ctx.agent.on("post_compact", () => {
    // Compaction is append-only (it appends a <compacted> boundary rather than
    // truncating), so message indices don't shift and index-anchored cards stay
    // valid — leave them in place.
    const notice = ctx.pendingAutoCompactNotice;
    ctx.pendingAutoCompactNotice = null;
    if (notice) {
      ctx.screen.card(t.hooks.autoCompact(notice.before, notice.after), {
        kind: "info",
        title: t.hooks.autoCompactTitle,
      });
    }
  });

  // `pre_user_prompt` is the turn's single start point — fire the working
  // spinner once per task instead of rebuilding it on every model call. It
  // runs for the whole turn, through tool and permission phases; an interactive
  // permission dialog simply replaces it on screen (the viewport renders the
  // modal instead of the spinner) and it comes back when the dialog closes.
  // It is torn down once at post_turn / error.
  ctx.agent.on("pre_user_prompt", () => {
    // Anchor the spinner timer to the turn start so it counts total task time
    // rather than resetting on each request/tool phase.
    ctx.taskStartedAt = Date.now();
    startWorkingSpinner(ctx);
  });

  ctx.agent.on("post_request", ({ durationMs, error, usage }) => {
    if (error) {
      // Read the label BEFORE stopping the spinner — stopSpinner nulls
      // ctx.spinner, so a label read afterwards would always fall back to
      // "working" instead of the word actually on screen.
      const word = ctx.spinner?.label() ?? "working";
      stopSpinner(ctx);
      // No post_messages follows a failed/aborted request, so drop the partial
      // draft here — otherwise half-streamed text would hang under the error.
      ctx.resetLiveStream();
      // User-initiated interruptions (permission denial, Ctrl+C) are normal
      // interaction, not errors — don't clutter the feed with a red card.
      const isUserAction = /denied at prompt|aborted|interrupted/i.test(error);
      if (!isUserAction) {
        const seconds = (durationMs / 1000).toFixed(1);
        ctx.screen.card(t.hooks.requestFailed(word, seconds, error), {
          kind: "error",
          title: t.hooks.requestFailedTitle,
        });
      }
    }
    // Snapshot how full the context window is from the request's token usage.
    // The input side is the full prompt sent; output is appended for next turn.
    if (usage) {
      const used =
        usage.inputTokens +
        (usage.cacheReadInputTokens ?? 0) +
        (usage.cacheCreationInputTokens ?? 0) +
        usage.outputTokens;
      ctx.screen.setContextTokens(used);
      // Fold the same usage into the session-cumulative counters behind the
      // cache-hit-rate meter and `/usage`.
      ctx.screen.addUsage(usage);
    }
  });

  ctx.agent.on("post_turn", () => {
    ctx.taskStartedAt = null;
    stopSpinner(ctx);
    refreshTodoFooter(ctx);
    void refreshTaskFooter(ctx);
    // The turn has settled — if a checklist/plan is now fully completed, wipe it
    // after a short delay so the ✓'d list is visible for a beat first.
    scheduleTodoAutoClear(ctx);
    void scheduleTaskAutoClear(ctx);
  });

  ctx.agent.on("error", ({ message }) => {
    ctx.taskStartedAt = null;
    stopSpinner(ctx);
    ctx.screen.card(t.hooks.loopTerminated(message, ctx.logPath), {
      kind: "error",
      title: t.hooks.loopTerminatedTitle,
    });
  });
}
