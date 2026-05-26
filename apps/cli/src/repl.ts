import { CYAN_RGB, cyan, dim } from "./colors.js";
import { stopSpinner, type CliContext } from "./context.js";
import { predictNextInput } from "./predict.js";
import { toUiSlashCommands } from "./slash.js";

async function refreshPrediction(ctx: CliContext): Promise<void> {
  if (!ctx.settings.predict.enabled) return;
  const messages = ctx.screen.getMessages();
  if (messages.length === 0) return;
  ctx.spinner = ctx.screen.startSpinner({
    words: ["Thinking ahead..."],
    tint: CYAN_RGB,
    colorize: cyan,
  });
  const t0 = Date.now();
  try {
    const result = await predictNextInput({
      model: ctx.model,
      messages,
      maxChars: ctx.settings.predict.maxChars,
      timeoutMs: ctx.settings.predict.timeoutMs,
      ...(ctx.memory.system ? { memorySystem: ctx.memory.system } : {}),
    });
    stopSpinner(ctx);
    const durationMs = Date.now() - t0;
    if (result.text) {
      ctx.nextPlaceholder = result.text;
      ctx.logger.debug({ text: result.text, durationMs }, "predict ok");
    } else {
      ctx.logger.info(
        { error: result.error, raw: result.raw, durationMs },
        "predict produced no placeholder",
      );
    }
  } catch (err) {
    stopSpinner(ctx);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: msg }, "predict threw");
  }
}

type DispatchAction =
  | "exit"
  | "continue"
  | { kind: "turn"; prompt: string };

/**
 * Returns "exit" to leave the REPL, "continue" to skip the LLM turn, or a
 * turn descriptor with the prompt text to feed to the agent.
 */
async function dispatchLine(ctx: CliContext, line: string): Promise<DispatchAction> {
  if (line === "/exit" || line === "/quit") return "exit";
  if (!line.startsWith("/")) return { kind: "turn", prompt: line };

  const hit = ctx.registry.resolve(line);
  if (!hit) {
    return { kind: "turn", prompt: line };
  }
  const outcome = await hit.cmd.run({ cwd: ctx.workspace }, hit.args);
  if (outcome.kind === "prompt") {
    return { kind: "turn", prompt: outcome.text };
  }
  if (outcome.kind === "error") {
    ctx.screen.card(outcome.message, { kind: "error", title: `/${hit.cmd.name}` });
  }
  return "continue";
}

/**
 * Drive one user turn through the agent. The agent owns transcript/persist/
 * lifecycle; the REPL just binds the ESC key to its abort method and reports
 * the post-turn state.
 */
async function runTurn(ctx: CliContext, input: string): Promise<boolean> {
  ctx.screen.setEscHandler(() => ctx.agent.abort(new Error("interrupted by user")));
  try {
    const result = await ctx.agent.runTurn(input);
    if (result.aborted) {
      ctx.screen.card(dim("interrupted by user"), { title: "ESC" });
    }
    return result.ok;
  } finally {
    ctx.screen.setEscHandler(null);
  }
}

export async function runRepl(ctx: CliContext, initialPrompt: string): Promise<void> {
  if (initialPrompt) {
    const ok = await runTurn(ctx, initialPrompt);
    if (ok) await refreshPrediction(ctx);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const placeholder = ctx.nextPlaceholder;
    ctx.nextPlaceholder = "";
    const raw = await ctx.screen.promptInput({
      commands: toUiSlashCommands(ctx.registry.list()),
      ...(placeholder ? { placeholder } : {}),
    });
    if (raw === null) break;
    const line = raw.trim();
    if (!line) continue;

    const action = await dispatchLine(ctx, line);
    if (action === "exit") break;
    if (action === "continue") continue;

    const ok = await runTurn(ctx, action.prompt);
    if (ok) await refreshPrediction(ctx);
  }

  await ctx.transcript.flush();
  await ctx.longRunningManager.disposeAll();
  await ctx.screen.unmount();
}
