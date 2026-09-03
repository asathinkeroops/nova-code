import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolveProfile } from "@nova/model";
import { activeProvider, activeProviderProfile, resolveApiKey } from "@nova/base";
import { resolveContextWindowSize, resolveModelId } from "@nova/base";
import { magenta } from "./colors.js";
import { t } from "./i18n/index.js";
import { resolveSessionRates } from "./commands/usage.js";
import type { CliContext } from "./ctx-types.js";

/** Current branch of the workspace repo, or null when not a repo / detached. */
function currentGitBranch(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && out !== "HEAD" ? out : null;
  } catch {
    return null;
  }
}

export function refreshBanner(ctx: CliContext): void {
  // Effective window follows the active model tier (a tier may override the
  // top-level contextWindowSize); recomputed here so /model switches it live.
  const contextWindowSize = resolveContextWindowSize(ctx.settings, ctx.settings.model);
  ctx.screen.setBanner({
    version: ctx.version,
    model: ctx.settings.model,
    modelId: resolveModelId(ctx.settings, ctx.settings.model),
    cwd: ctx.workspace,
    home: homedir(),
    sessionId: ctx.session.id,
    contextWindowSize,
    thinkingLabel: thinkingLevelLabel(ctx),
    provider: activeProviderProfile(ctx.settings) ?? "generic",
  });
  ctx.screen.setStatusMeta({
    sessionStartedAt: ctx.session.createdAt.getTime(),
    gitBranch: currentGitBranch(ctx.workspace),
    contextWindowSize,
  });
  ctx.screen.setCostRates(resolveSessionRates(ctx) ?? null);
}

/**
 * Refresh the account balance shown on the StatusLine's second row via the
 * active provider profile's `probeBalance` hook. A no-op for providers without
 * the hook, or (for DeepSeek) unless the base URL points at its official API;
 * best-effort and self-contained — `probeBalance` swallows its own errors and
 * resolves to null, which `setAccountBalance` treats as "hide". Always call
 * fire-and-forget so a slow request never delays a turn.
 */
export async function refreshBalance(ctx: CliContext): Promise<void> {
  const provider = activeProvider(ctx.settings);
  const profile = resolveProfile(activeProviderProfile(ctx.settings) ?? "generic");
  const balance = await profile.probeBalance?.({
    baseURL: provider?.baseURL,
    apiKey: resolveApiKey(ctx.settings),
  });
  // Leave a previously-fetched balance in place on a transient failure rather
  // than blanking the segment; only overwrite when we actually got a figure.
  if (balance) ctx.screen.setAccountBalance(balance);
}

export function refreshTodoFooter(ctx: CliContext): void {
  ctx.screen.setTodos(ctx.todoStore.list());
}

export async function refreshTaskFooter(ctx: CliContext): Promise<void> {
  ctx.screen.setTasks(await ctx.taskStore.list());
}

/** A non-empty list with every item completed — the auto-clear trigger. */
function allCompleted(items: readonly { status: string }[]): boolean {
  return items.length > 0 && items.every((i) => i.status === "completed");
}

/**
 * When every todo is completed, wipe the checklist after
 * `settings.todo.autoClearDelayMs` so the ✓'d list stays on screen for a beat,
 * then refresh the footer so it actually disappears (the store doesn't notify
 * the UI on its own). A deterministic replacement for nagging the model to call
 * clearTodoList — which it routinely drops once it starts its final summary.
 *
 * Guards: a new schedule cancels any prior pending one; at fire time it
 * re-checks the all-completed condition (a fresh todo, a manual clear, or a
 * session switch in the meantime cancels the wipe) and confirms the store is
 * still the active one, so a timer armed before a `/clear`/`/resume` switch
 * can't clobber the session switched in. `delayMs <= 0` disables auto-clear.
 */
export function scheduleTodoAutoClear(ctx: CliContext): void {
  if (ctx.todoAutoClearTimer) {
    clearTimeout(ctx.todoAutoClearTimer);
    ctx.todoAutoClearTimer = null;
  }
  const delayMs = ctx.settings.todo.autoClearDelayMs;
  if (delayMs <= 0) return;
  const store = ctx.todoStore;
  if (!allCompleted(store.list())) return;
  ctx.todoAutoClearTimer = setTimeout(() => {
    ctx.todoAutoClearTimer = null;
    if (ctx.todoStore !== store) return; // session switched out from under us
    if (!allCompleted(store.list())) return; // list changed during the delay
    store.clear();
    refreshTodoFooter(ctx);
  }, delayMs);
  ctx.todoAutoClearTimer.unref();
}

/** Task-store mirror of {@link scheduleTodoAutoClear} (list is async; clear also deletes `.tasks/` files). */
export async function scheduleTaskAutoClear(ctx: CliContext): Promise<void> {
  if (ctx.taskAutoClearTimer) {
    clearTimeout(ctx.taskAutoClearTimer);
    ctx.taskAutoClearTimer = null;
  }
  const delayMs = ctx.settings.task.autoClearDelayMs;
  if (delayMs <= 0) return;
  const store = ctx.taskStore;
  if (!allCompleted(await store.list())) return;
  ctx.taskAutoClearTimer = setTimeout(() => {
    ctx.taskAutoClearTimer = null;
    void (async () => {
      if (ctx.taskStore !== store) return; // session switched out from under us
      if (!allCompleted(await store.list())) return; // plan changed during the delay
      await store.clear();
      await refreshTaskFooter(ctx);
    })();
  }, delayMs);
  ctx.taskAutoClearTimer.unref();
}

export function stopSpinner(ctx: CliContext): void {
  if (ctx.spinner) {
    ctx.spinner.stop();
    ctx.spinner = null;
  }
}

/**
 * Start the turn's working spinner, anchored to the turn start so the elapsed
 * timer never resets across model / tool phases. No-op when a spinner is
 * already live, so it never flickers on a per-request basis. Called once per
 * turn from the `pre_user_prompt` hook; the spinner then runs until post_turn /
 * error.
 */
export function startWorkingSpinner(ctx: CliContext): void {
  if (ctx.spinner) return;
  ctx.taskStartedAt ??= Date.now();
  ctx.spinner = ctx.screen.startSpinner(
    { words: t.spinner.workingWords, colorize: magenta },
    t.spinner.interruptHint,
    ctx.taskStartedAt,
  );
}

export async function persist(ctx: CliContext): Promise<void> {
  try {
    await ctx.agent.persist();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(msg, { kind: "warn", title: "persist failed" });
  }
}

export function thinkingLevelLabel(ctx: CliContext): string | undefined {
  return ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel;
}
