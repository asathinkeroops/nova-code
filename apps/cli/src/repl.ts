import { CYAN_RGB, cyan } from "./colors.js";
import {
  handleClear,
  handleCompact,
  handleHelp,
  handleModel,
  handlePredict,
  handleResume,
  handleThink,
} from "./commands/index.js";
import { SLASH_COMMANDS } from "./constants.js";
import { stopSpinner, type CliContext } from "./context.js";
import { predictNextInput } from "./predict.js";
import { runTurn } from "./turn.js";

async function refreshPrediction(ctx: CliContext): Promise<void> {
  if (!ctx.settings.predict.enabled) return;
  if (ctx.messages.length === 0) return;
  ctx.spinner = ctx.screen.startSpinner({
    words: ["Thinking ahead..."],
    tint: CYAN_RGB,
    colorize: cyan,
  });
  const t0 = Date.now();
  try {
    const result = await predictNextInput({
      model: ctx.model,
      messages: ctx.messages,
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

/**
 * Returns true if the REPL should keep running, false if the user asked to
 * exit. Returning a sentinel keeps `runRepl` simpler than throwing.
 */
async function dispatchLine(ctx: CliContext, line: string): Promise<"continue" | "exit" | "turn"> {
  if (line === "/exit" || line === "/quit") return "exit";
  if (line === "/help") {
    handleHelp(ctx);
    return "continue";
  }
  if (line === "/clear") {
    await handleClear(ctx);
    return "continue";
  }
  if (line === "/compact" || line.startsWith("/compact ")) {
    await handleCompact(ctx, line.slice("/compact".length).trim());
    return "continue";
  }
  if (line === "/resume" || line.startsWith("/resume ")) {
    await handleResume(ctx, line.slice("/resume".length).trim());
    return "continue";
  }
  if (line === "/model" || line.startsWith("/model ")) {
    await handleModel(ctx, line.slice("/model".length).trim());
    return "continue";
  }
  if (line === "/predict" || line.startsWith("/predict ")) {
    await handlePredict(ctx, line.slice("/predict".length).trim());
    return "continue";
  }
  if (line === "/think" || line.startsWith("/think ")) {
    await handleThink(ctx, line.slice("/think".length).trim());
    return "continue";
  }
  return "turn";
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
      commands: SLASH_COMMANDS,
      ...(placeholder ? { placeholder } : {}),
    });
    if (raw === null) break;
    const line = raw.trim();
    if (!line) continue;

    const action = await dispatchLine(ctx, line);
    if (action === "exit") break;
    if (action === "continue") continue;

    // Non-slash: run a user turn.
    const ok = await runTurn(ctx, line);
    if (ok) await refreshPrediction(ctx);
  }

  await ctx.transcript.flush();
  await ctx.screen.unmount();
}
