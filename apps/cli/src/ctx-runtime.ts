import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  resolveProfile,
} from "@nova/model";
import {
  resolveBudget,
} from "@nova/base";
import { resolveContextWindowSize, resolveModelId } from "@nova/base";
import { accent } from "./colors.js";
import { TOOL_SPINNER_DELAY_MS } from "./constants.js";
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
    provider: ctx.settings.provider,
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
  const profile = resolveProfile(ctx.settings.provider);
  const balance = await profile.probeBalance?.({
    baseURL: ctx.settings.baseURL,
    apiKey: ctx.settings.apiKey,
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
 * Tool execution spinner: starts 300ms after a tool enters its execution
 * phase, stops on post_tool_use. The delay swallows the visual flash for fast
 * tools (Read of small files, Glob with few hits, etc.).
 */
export function armToolSpinner(ctx: CliContext): void {
  if (ctx.toolSpinnerTimer) clearTimeout(ctx.toolSpinnerTimer);
  ctx.toolSpinnerTimer = setTimeout(() => {
    ctx.toolSpinnerTimer = null;
    ctx.spinner = ctx.screen.startSpinner(
      { words: t.spinner.workingWords, colorize: accent },
      t.spinner.interruptHint,
      ctx.taskStartedAt ?? undefined,
    );
  }, TOOL_SPINNER_DELAY_MS);
}

export function clearToolSpinner(ctx: CliContext): void {
  if (ctx.toolSpinnerTimer) {
    clearTimeout(ctx.toolSpinnerTimer);
    ctx.toolSpinnerTimer = null;
  }
  stopSpinner(ctx);
}

export async function persist(ctx: CliContext): Promise<void> {
  try {
    await ctx.agent.persist();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(msg, { kind: "warn", title: "persist failed" });
  }
}

export function currentThinkingBudget(ctx: CliContext): number {
  return resolveBudget(ctx.thinkingLevel, ctx.thinkingBudgetOverride);
}

export function thinkingLevelLabel(ctx: CliContext): string | undefined {
  const budget = currentThinkingBudget(ctx);
  if (budget <= 0) return undefined;
  if (ctx.thinkingBudgetOverride && ctx.thinkingBudgetOverride > 0) {
    return `${budget}t`;
  }
  return ctx.thinkingLevel;
}
