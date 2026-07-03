import { join } from "node:path";
import { sliceFromLastCompacted } from "@nova/context";
import { bashTool } from "@nova/tools";
import { resolveModelModalities } from "@nova/runtime";
import { ACCENT_RGB, accent, dim, green } from "./colors.js";
import { refreshBalance, stopSpinner, type CliContext } from "./context.js";
import { appendUserOverride } from "./display-sidecar.js";
import { readClipboard } from "./image-paste.js";
import { evaluateGoalWithAgent } from "./goal-eval.js";
import { clearGoal, saveGoal } from "./goal.js";
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
  // Predict from the model-facing view (post-<compacted> slice) so the prompt
  // stays bounded and matches what the agent sees; retained history is on disk.
  const messages = sliceFromLastCompacted(ctx.screen.getMessages());
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
 * Build the shell runner threaded into custom-command expansion for
 * `` !`cmd` `` interpolation. Reuses the builtin `bash` tool + OS sandbox bridge
 * so command-authored shell stays write-confined to the workspace, same as the
 * model's bash calls and the user's own `!` lines.
 */
function makeCommandRunner(
  ctx: CliContext,
): (command: string) => Promise<{ output: string; isError: boolean }> {
  const bridge = ctx.sandbox?.bridge;
  return async (command) => {
    const result = await bashTool.run(
      { command },
      { cwd: ctx.workspace, ...(bridge ? { sandbox: bridge } : {}) },
    );
    return { output: result.output, isError: result.isError ?? false };
  };
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
  const outcome = await hit.cmd.run(
    { cwd: ctx.workspace, runCommand: makeCommandRunner(ctx) },
    hit.args,
  );
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

const GOAL_TITLE = "/goal";

/**
 * When a `/goal` is active, judge whether it is met and decide what to do next.
 * Returns a continuation prompt to force another turn, or null to stop (goal met,
 * budget exhausted, disabled, or the check failed/was skipped). Mutates and
 * persists the goal's continuation counter and always surfaces a status card.
 *
 * The judge is a real, isolated agent with the full tool set (see
 * evaluateGoalWithAgent), so it can verify against the live state — run tests,
 * read files, fetch data — going through the normal permission prompts.
 */
async function maybeContinueForGoal(ctx: CliContext): Promise<string | null> {
  const goal = ctx.goal;
  if (!goal || !ctx.settings.goal.enabled) return null;

  const controller = new AbortController();
  ctx.spinner = ctx.screen.startSpinner(
    { words: ["Verifying goal..."], tint: ACCENT_RGB, colorize: accent },
    "esc to skip",
  );
  ctx.screen.setEscHandler(() => controller.abort());
  let verdict;
  try {
    verdict = await evaluateGoalWithAgent(ctx, goal, controller.signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: msg }, "goal evaluation failed");
    ctx.screen.card(dim(`goal check skipped: ${msg}`), { kind: "warn", title: GOAL_TITLE });
    return null;
  } finally {
    ctx.screen.setEscHandler(null);
    stopSpinner(ctx);
  }

  ctx.logger.info({ met: verdict.met, continuations: goal.continuations }, "goal evaluated");

  if (verdict.met) {
    ctx.goal = null;
    await clearGoal(ctx.session.dir);
    ctx.screen.card(`${green("🎯 goal achieved:")} ${goal.condition}\n${dim(verdict.reason)}`, {
      kind: "info",
      title: GOAL_TITLE,
    });
    return null;
  }

  const max = ctx.settings.goal.maxContinuations;
  if (goal.continuations >= max) {
    ctx.goal = null;
    await clearGoal(ctx.session.dir);
    ctx.screen.card(
      `goal not reached after ${goal.continuations} continuation(s); stopping.\n${dim(verdict.reason)}`,
      { kind: "warn", title: GOAL_TITLE },
    );
    return null;
  }

  goal.continuations++;
  try {
    await saveGoal(ctx.session.dir, goal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: msg }, "failed to persist goal");
  }
  ctx.screen.card(
    dim(`goal not yet met — continuing (${goal.continuations}/${max})\n${verdict.reason}`),
    { title: GOAL_TITLE },
  );
  // Wrap in <goal-eval> so the UI hides this auto-injected continuation from the
  // message stream (see isSystemInjectionText) — it is the evaluator driving
  // another turn, not something the user typed (it never flows through
  // enqueueInput, so ↑/↓ recall never captures it). The model still reads the
  // tag's contents normally.
  return (
    `<goal-eval>\n` +
    `Your goal is not complete yet. Evaluation: ${verdict.reason}\n\n` +
    `Keep working toward this goal: ${goal.condition}\n` +
    `</goal-eval>`
  );
}

/**
 * Run a turn, then keep it going while either a Stop hook or an active `/goal`
 * asks for more. Each iteration: (1) Stop hooks — an exit-2 forces a continue
 * with the hook's stderr as the next prompt (priority, since the user wired it
 * explicitly); then (2) goal evaluation forces a continue with the judge's
 * feedback until the condition is met or its budget is spent. Both paths are
 * independently capped so neither can loop forever. Aborted turns are not
 * continued (`ok` is false).
 */
async function runTurnWithStopHooks(ctx: CliContext, prompt: string): Promise<boolean> {
  let ok = await runTurn(ctx, prompt);
  let stopContinuations = 0;
  while (ok) {
    const decision = await ctx.userHooks.runStop({ stop_continuation: stopContinuations });
    if (decision.continue) {
      if (stopContinuations >= MAX_STOP_CONTINUATIONS) {
        ctx.screen.card(
          `Stop hook kept blocking; stopping after ${MAX_STOP_CONTINUATIONS} continuations`,
          { kind: "warn", title: "Stop hook" },
        );
        break;
      }
      stopContinuations++;
      ok = await runTurn(ctx, decision.reason || "A Stop hook requested that you keep going.");
      continue;
    }
    // Stop hooks satisfied — consult an active /goal for one more turn.
    const goalPrompt = await maybeContinueForGoal(ctx);
    if (goalPrompt === null) break;
    ok = await runTurn(ctx, goalPrompt);
  }
  return ok;
}

/**
 * Wire the input box's image-paste handlers. Ctrl+V reads the clipboard: an
 * image is saved into the session's `images/` dir and returned as a path, else
 * it falls back to clipboard text (so Ctrl+V never eats a normal paste).
 * Drag-dropped paths are normalized in the input box itself. Inserted image
 * paths report through `attached`, which confirms the attachment and — per the
 * model's live image modality — warns when the active model can't consume images
 * (the path is still inserted, so it works once the user switches to an
 * image-capable model). Modalities are re-read on each call so `/model` switches
 * are reflected without re-wiring.
 */
function wireImagePaste(ctx: CliContext): void {
  ctx.screen.setImagePaste({
    capture: async () => {
      const res = await readClipboard(join(ctx.session.dir, "images"));
      if (!res) ctx.screen.notice("clipboard is empty", 1000, "warn");
      return res;
    },
    attached: () => {
      const supportsImage = resolveModelModalities(
        ctx.settings,
        ctx.settings.model,
      ).input.includes("image");
      if (supportsImage) {
        ctx.screen.notice("📎 image attached");
      } else {
        ctx.screen.notice(
          "⚠ current model can't read images — path inserted anyway",
          4000,
          "warn",
        );
      }
    },
  });
}

export async function runRepl(ctx: CliContext, initialPrompt: string): Promise<void> {
  // The InputBox is a permanent fixture that always enqueues; the REPL is the
  // single consumer. Prompts typed while a turn runs pile up in the queue and
  // are drained here one turn at a time.
  ctx.screen.setSlashCommands(toUiSlashCommands(ctx.registry.list()));
  await refreshMentionFiles(ctx);
  wireImagePaste(ctx);

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
