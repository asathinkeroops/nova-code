import { agentLoop, userText } from "@nova/core";
import { makeTodoReminder } from "@nova/orchestration";
import { dim } from "./colors.js";
import {
  clearToolSpinner,
  currentThinkingBudget,
  persist,
  refreshTodoFooter,
  stopSpinner,
  type CliContext,
} from "./context.js";
import { createObserver } from "./observer.js";
import { buildSystemPrompt } from "./system-prompt.js";

/**
 * Run one user turn through the agent loop. Returns `true` on success,
 * `false` on error or abort (with messages rolled back on abort so the
 * conversation state stays valid).
 */
export async function runTurn(ctx: CliContext, userInput: string): Promise<boolean> {
  const withUserText = [...ctx.screen.getMessages(), userText(userInput)];
  // Show the user's prompt immediately — the loop's first messages_changed
  // event would do this too, but only after model.call starts; with the model
  // request in flight the gap can be hundreds of ms.
  ctx.screen.setMessages(withUserText);
  await ctx.transcript.append({ kind: "user_prompt", data: { text: userInput } });

  const abortController = new AbortController();
  ctx.turnState.abort = abortController;
  ctx.screen.setEscHandler(() => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error("interrupted by user"));
    }
  });

  const observer = createObserver(ctx);

  try {
    const budget = currentThinkingBudget(ctx);
    const result = await agentLoop({
      model: ctx.model,
      system: buildSystemPrompt(ctx.workspace, ctx.memory, ctx.session.id),
      tools: ctx.tools.definitions(),
      executeTool: ctx.dispatch,
      messages: withUserText,
      maxTokens: ctx.settings.maxTokens,
      maxTurns: ctx.settings.maxTurns,
      toolContext: {
        cwd: ctx.workspace,
        signal: abortController.signal,
        fileLedger: ctx.fileLedger,
        askUser: async (req) => {
          clearToolSpinner(ctx);
          return await ctx.screen.askUser(req, { signal: abortController.signal });
        },
      },
      checkPermission: ctx.checkPermission,
      observer,
      compactor: ctx.compactor,
      interject: makeTodoReminder(ctx.todoStore),
      ...(budget > 0 ? { thinkingBudgetTokens: budget } : {}),
    });

    // The observer's `messages_changed` handler has been mirroring the loop's
    // accumulator into the store the whole way; result.messages is the final
    // snapshot of that same stream. Forward it once more defensively so any
    // skipped event (best-effort observer) can't leave persist out of sync.
    ctx.screen.setMessages(result.messages);
    await persist(ctx);

    ctx.logger.info(
      {
        turns: result.turns,
        stopReason: result.stopReason,
        usage: result.totalUsage,
      },
      "loop finished",
    );
    await ctx.transcript.flush();
    return true;
  } catch (err) {
    stopSpinner(ctx);
    if (abortController.signal.aborted) {
      // The user message we pushed to the store before the loop stays
      // visible — observer.messages_changed kept the store in sync up to the
      // abort point. The Anthropic API tolerates a trailing user turn (and
      // even consecutive user turns), so this stays valid for the next call.
      ctx.screen.card(dim("interrupted by user"), { title: "ESC" });
      ctx.logger.info({}, "loop interrupted by user");
      await ctx.transcript.append({ kind: "error", data: { message: "interrupted by user" } });
      await ctx.transcript.flush();
    } else {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      ctx.logger.error({ err: msg }, "loop terminated");
      const head = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      ctx.screen.card(`${head}\nsee log: ${ctx.logPath}`, {
        kind: "error",
        title: "loop terminated",
      });
      await ctx.transcript.append({ kind: "error", data: { message: msg } });
      await ctx.transcript.flush();
    }
    return false;
  } finally {
    ctx.turnState.abort = null;
    ctx.screen.setEscHandler(null);
    // Todos are per-turn scratch state; drop them once the loop ends so the
    // next turn starts with a clean footer (covers success, error, and abort).
    ctx.todoStore.clear();
    refreshTodoFooter(ctx);
  }
}
