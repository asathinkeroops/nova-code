import { bashTool } from "@nova/tools";
import { ACCENT_RGB, accent, dim } from "./colors.js";
import { refreshBalance, stopSpinner, type CliContext } from "./context.js";
import { appendUserOverride } from "./display-sidecar.js";
import { listWorkspaceFiles } from "./file-index.js";
import { predictNextInput } from "./predict.js";
import { toUiSlashCommands } from "./slash.js";
import { CONTINUE_SENTINEL } from "./ui/store.js";

/**
 * Rebuild the workspace file snapshot that powers `@path` mention completion in
 * the InputBox. Best-effort — a failure just leaves the previous snapshot in
 * place; completion degrades to nothing rather than breaking the REPL.
 */
async function refreshMentionFiles(ctx: CliContext): Promise<void> {
  try {
    const files = await listWorkspaceFiles(ctx.workspace);
    ctx.screen.setMentionFiles(files);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: msg }, "failed to refresh @-mention file index");
  }
}

async function refreshPrediction(ctx: CliContext): Promise<void> {
  if (!ctx.settings.predict.enabled) return;
  const messages = ctx.screen.getMessages();
  if (messages.length === 0) return;
  ctx.spinner = ctx.screen.startSpinner({
    words: ["Thinking ahead..."],
    tint: ACCENT_RGB,
    colorize: accent,
  });
  const t0 = Date.now();
  try {
    const result = await predictNextInput({
      model: ctx.predictModel,
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

type DispatchAction = "exit" | "continue" | { kind: "turn"; prompt: string };

/**
 * Run a `!`-prefixed line as a shell command instead of an LLM turn. Calls the
 * builtin `bash` tool directly, threading in the OS sandbox bridge so writes
 * stay confined to the workspace — same confinement the model's bash calls get,
 * minus the permission prompt (the user typed the command themselves). Output
 * is shown as a card; ESC aborts mid-run.
 */
async function runBang(ctx: CliContext, command: string): Promise<void> {
  if (!command) {
    ctx.screen.card(dim("usage: !<shell command>"), { title: "!" });
    return;
  }
  const controller = new AbortController();
  const bridge = ctx.sandbox?.bridge;
  ctx.spinner = ctx.screen.startSpinner(
    { words: ["Running shell..."], tint: ACCENT_RGB, colorize: accent },
    "esc to interrupt",
  );
  ctx.screen.setEscHandler(() => controller.abort());
  try {
    const result = await bashTool.run(
      { command },
      { cwd: ctx.workspace, signal: controller.signal, ...(bridge ? { sandbox: bridge } : {}) },
    );
    // Keep the card title to a single line so a multi-line command doesn't blow
    // up the header.
    const title = `! ${command.split("\n", 1)[0]}`;
    ctx.screen.card(result.output.trim() || dim("(no output)"), {
      title,
      kind: result.isError ? "error" : "info",
    });
  } finally {
    ctx.screen.setEscHandler(null);
    stopSpinner(ctx);
  }
}

/**
 * Returns "exit" to leave the REPL, "continue" to skip the LLM turn, or a
 * turn descriptor with the prompt text to feed to the agent.
 */
async function dispatchLine(ctx: CliContext, line: string): Promise<DispatchAction> {
  if (line === "/exit" || line === "/quit") return "exit";
  if (line.startsWith("!")) {
    await runBang(ctx, line.slice(1).trim());
    return "continue";
  }
  if (!line.startsWith("/")) return { kind: "turn", prompt: line };

  const hit = ctx.registry.resolve(line);
  if (!hit) {
    return { kind: "turn", prompt: line };
  }
  const outcome = await hit.cmd.run({ cwd: ctx.workspace }, hit.args);
  if (outcome.kind === "prompt") {
    // The model receives the expanded prompt, but the transcript should show
    // what the user actually typed. Record the mapping (in-memory + on-disk so
    // it survives /resume) only when the command genuinely expanded.
    if (outcome.text !== line) {
      ctx.screen.addUserDisplayOverride(outcome.text, line);
      try {
        await appendUserOverride(ctx.session.dir, outcome.text, line);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn({ err: msg }, "failed to persist display override");
      }
    }
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
    return result.ok;
  } finally {
    ctx.screen.setEscHandler(null);
  }
}

/**
 * Resume the agent with no new user message so it can react to a background
 * command that finished while idle. The completion output is injected by the
 * `pre_request` notifier inside the loop; here we just drive the turn and bind
 * ESC, mirroring {@link runTurn}.
 */
async function runContinuationTurn(ctx: CliContext): Promise<boolean> {
  ctx.screen.setEscHandler(() => ctx.agent.abort(new Error("interrupted by user")));
  try {
    const result = await ctx.agent.continueTurn();
    return result.ok;
  } finally {
    ctx.screen.setEscHandler(null);
  }
}

/**
 * True when a background command has finished and the agent should wake to react
 * to it now, rather than waiting for the next typed prompt. Gated by the setting
 * and only meaningful between turns (no turn in flight).
 */
function shouldAutoContinue(ctx: CliContext): boolean {
  return (
    ctx.settings.longRunning.autoContinueOnComplete &&
    ctx.longRunningManager.hasPending() &&
    !ctx.agent.currentSignal()
  );
}

/** Hard cap on Stop-hook forced continuations, so a misbehaving hook can't loop forever. */
const MAX_STOP_CONTINUATIONS = 8;

/**
 * Run a turn, then consult Stop hooks. A Stop hook that exits 2 forces the turn
 * to continue: its stderr becomes the next prompt and we run again, up to a hard
 * cap. The payload's `stop_continuation` (0-based) lets a hook see how many times
 * it has already forced a continue and bow out. Aborted turns are not continued.
 */
async function runTurnWithStopHooks(ctx: CliContext, prompt: string): Promise<boolean> {
  let ok = await runTurn(ctx, prompt);
  for (let i = 0; ok; i++) {
    const decision = await ctx.userHooks.runStop({ stop_continuation: i });
    if (!decision.continue) break;
    if (i >= MAX_STOP_CONTINUATIONS) {
      ctx.screen.card(
        `Stop hook kept blocking; stopping after ${MAX_STOP_CONTINUATIONS} continuations`,
        {
          kind: "warn",
          title: "Stop hook",
        },
      );
      break;
    }
    ok = await runTurn(ctx, decision.reason || "A Stop hook requested that you keep going.");
  }
  return ok;
}

export async function runRepl(ctx: CliContext, initialPrompt: string): Promise<void> {
  // The InputBox is a permanent fixture that always enqueues; the REPL is the
  // single consumer. Prompts typed while a turn runs pile up in the queue and
  // are drained here one turn at a time.
  ctx.screen.setSlashCommands(toUiSlashCommands(ctx.registry.list()));
  await refreshMentionFiles(ctx);

  const startSource = ctx.resumed ? "resume" : "startup";
  await ctx.userHooks.fire("SessionStart", {
    subject: startSource,
    fields: { source: startSource },
  });

  // Seed the DeepSeek balance segment on the StatusLine (no-op off DeepSeek's
  // official API). Fire-and-forget so a slow/blocked request never delays the
  // first prompt; it's refreshed after every turn below as tokens are spent.
  void refreshBalance(ctx);

  if (initialPrompt) {
    const ok = await runTurnWithStopHooks(ctx, initialPrompt);
    if (ok) await refreshPrediction(ctx);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // A background command may have finished while we were busy with the
    // previous turn / prediction; react to it before parking for input.
    if (shouldAutoContinue(ctx)) {
      const ok = await runContinuationTurn(ctx);
      if (ok) await refreshPrediction(ctx);
      void refreshMentionFiles(ctx);
      void refreshBalance(ctx);
      continue;
    }

    ctx.screen.setInputPlaceholder(ctx.nextPlaceholder);
    ctx.nextPlaceholder = "";

    const raw = await ctx.screen.takeInput();
    if (raw === null) break; // exit requested (Ctrl+C while idle)
    // A background completion landed while we were parked: `wake()` unblocked
    // takeInput with this sentinel so we run a continuation instead of a prompt.
    if (raw === CONTINUE_SENTINEL) {
      const ok = await runContinuationTurn(ctx);
      if (ok) await refreshPrediction(ctx);
      void refreshMentionFiles(ctx);
      void refreshBalance(ctx);
      continue;
    }
    const line = raw.trim();
    if (!line) continue;

    const action = await dispatchLine(ctx, line);
    if (action === "exit") break;
    if (action === "continue") continue;

    const ok = await runTurnWithStopHooks(ctx, action.prompt);
    if (ok) await refreshPrediction(ctx);
    // Pick up files created/deleted during the turn. Fire-and-forget so it
    // never delays the next prompt; the function swallows its own errors.
    void refreshMentionFiles(ctx);
    void refreshBalance(ctx);
  }

  // SessionEnd runs before teardown so the hook can still use the sandbox bridge.
  await ctx.userHooks.fire("SessionEnd", {
    subject: "exit",
    fields: { reason: "exit" },
  });

  await ctx.transcript.flush();
  await ctx.longRunningManager.disposeAll();
  if (ctx.lspManager) await ctx.lspManager.disposeAll();
  await ctx.sandbox.dispose();
  if (ctx.mcp) await ctx.mcp.close();
  await ctx.screen.unmount();
}
