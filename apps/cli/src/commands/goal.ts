import type { SlashOutcome } from "@nova/external";
import { dim, green } from "../colors.js";
import type { CliContext } from "../context.js";
import { clearGoal, saveGoal, type GoalState } from "../goal.js";

const TITLE = "/goal";

/** Words that clear an active goal (mirrors Claude Code's `/goal` aliases). */
const CLEAR_WORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

function statusCard(ctx: CliContext): void {
  const goal = ctx.goal;
  if (!goal) {
    ctx.screen.card(
      `${dim("no active goal.")}\n${dim("set one with")} /goal <condition>`,
      { title: TITLE },
    );
    return;
  }
  const max = ctx.settings.goal.maxContinuations;
  ctx.screen.card(
    `${green("active goal:")} ${goal.condition}\n` +
      `${dim(`auto-continuations: ${goal.continuations}/${max}`)}`,
    { title: TITLE },
  );
}

/**
 * `/goal` — set, show, or clear the session's success condition. Setting one
 * immediately kicks off a turn toward it (returns a `prompt` outcome); the REPL
 * then re-checks after every turn (judged by a fast model) and auto-continues
 * until the condition is met or the continuation budget runs out. Persisted to
 * the session dir so it survives `/resume`.
 */
export async function handleGoal(ctx: CliContext, arg: string): Promise<SlashOutcome> {
  const a = arg.trim();

  if (!a) {
    statusCard(ctx);
    return { kind: "handled" };
  }

  if (CLEAR_WORDS.has(a.toLowerCase())) {
    if (!ctx.goal) {
      ctx.screen.card(dim("no active goal to clear."), { title: TITLE });
      return { kind: "handled" };
    }
    const was = ctx.goal.condition;
    ctx.goal = null;
    await clearGoal(ctx.session.dir);
    ctx.screen.card(`${dim("cleared goal:")} ${was}`, { title: TITLE });
    return { kind: "handled" };
  }

  if (!ctx.settings.goal.enabled) {
    ctx.screen.card(
      dim("goal mode is disabled (settings.goal.enabled = false)."),
      { kind: "warn", title: TITLE },
    );
    return { kind: "handled" };
  }

  const state: GoalState = { condition: a, setAt: Date.now(), continuations: 0 };
  ctx.goal = state;
  try {
    await saveGoal(ctx.session.dir, state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: msg }, "failed to persist goal");
  }
  ctx.screen.card(
    `${green("goal set:")} ${a}\n` +
      dim("Nova will work toward this now and re-check after each turn until it's met. ") +
      dim("Run /goal clear to stop."),
    { title: TITLE },
  );

  // Kick off the first turn toward the goal. After it completes, the REPL's
  // goal evaluator (maybeContinueForGoal) judges the result and auto-continues.
  const text =
    "Work toward the goal below until it is fully satisfied; if it needs " +
    "information to be gathered or actions to be taken, do them now. " +
    "Reply in the same language as the goal.\n\n" +
    `Goal:\n${a}`;
  return { kind: "prompt", text };
}
