import { agentLoop, userText } from "@nova/core";
import { makeTodoReminder } from "@nova/orchestration";
import { askUser } from "./ask.js";
import { dim, green, red } from "./colors.js";
import {
  clearToolSpinner,
  currentThinkingBudget,
  persist,
  stopSpinner,
  type CliContext,
} from "./context.js";
import { watchForEscape } from "./esc-watcher.js";
import { createObserver } from "./observer.js";
import { buildSystemPrompt } from "./system-prompt.js";

/**
 * Run one user turn through the agent loop. Returns `true` on success,
 * `false` on error or abort (with messages rolled back on abort so the
 * conversation state stays valid).
 */
export async function runTurn(ctx: CliContext, userInput: string): Promise<boolean> {
  const beforeMessageCount = ctx.messages.length;
  ctx.messages.push(userText(userInput));
  await ctx.transcript.append({ kind: "user_prompt", data: { text: userInput } });

  const abortController = new AbortController();
  const watcher = watchForEscape(() => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error("interrupted by user"));
    }
  });
  ctx.turnState.abort = abortController;
  ctx.turnState.watcher = watcher;

  const observer = createObserver(ctx);

  try {
    const budget = currentThinkingBudget(ctx);
    const result = await agentLoop({
      model: ctx.model,
      system: buildSystemPrompt(ctx.workspace, ctx.memory, ctx.session.id),
      tools: ctx.registry.definitions(),
      executeTool: ctx.dispatch,
      messages: ctx.messages,
      maxTokens: ctx.settings.maxTokens,
      maxTurns: ctx.settings.maxTurns,
      toolContext: {
        cwd: ctx.workspace,
        signal: abortController.signal,
        askUser: async (req) => {
          clearToolSpinner(ctx);
          watcher.suspend();
          ctx.screen.detach();
          try {
            return await askUser(req, { signal: abortController.signal });
          } finally {
            watcher.resume();
          }
        },
      },
      checkPermission: ctx.checkPermission,
      observer,
      compactor: ctx.compactor,
      interject: makeTodoReminder(ctx.todoStore),
      ...(budget > 0 ? { thinkingBudgetTokens: budget } : {}),
    });

    ctx.messages = result.messages;
    await persist(ctx);

    ctx.logger.info(
      {
        turns: result.turns,
        stopReason: result.stopReason,
        usage: result.totalUsage,
      },
      "loop finished",
    );
    ctx.screen.print(
      `\n${green("done")} ${dim(`· ${result.turns} turn(s) · ${result.stopReason} · in=${result.totalUsage.inputTokens} out=${result.totalUsage.outputTokens}`)}\n`,
    );
    await ctx.transcript.flush();
    return true;
  } catch (err) {
    stopSpinner(ctx);
    if (abortController.signal.aborted) {
      // Roll back the user message so the conversation state stays valid
      // (no dangling user turn without an assistant reply).
      ctx.messages.length = beforeMessageCount;
      ctx.screen.print(`\n${dim("✗ interrupted by user (esc)")}\n`);
      ctx.logger.info({}, "loop interrupted by user");
      await ctx.transcript.append({ kind: "error", data: { message: "interrupted by user" } });
      await ctx.transcript.flush();
    } else {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      ctx.logger.error({ err: msg }, "loop terminated");
      const head = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      ctx.screen.printErr(
        `\n${red(`✗ loop terminated — ${head}`)}\n  ${dim(`see log: ${ctx.logPath}`)}\n`,
      );
      await ctx.transcript.append({ kind: "error", data: { message: msg } });
      await ctx.transcript.flush();
    }
    return false;
  } finally {
    ctx.turnState.abort = null;
    ctx.turnState.watcher = null;
    watcher.dispose();
  }
}
