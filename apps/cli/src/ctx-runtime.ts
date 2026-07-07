import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolveBudget } from "@nova/core";
import { resolveContextWindowSize, resolveModelId } from "@nova/runtime";
import { ACCENT_RGB, accent } from "./colors.js";
import { TOOL_SPINNER_DELAY_MS, WORKING_WORDS } from "./constants.js";
import { resolveSessionRates } from "./commands/usage.js";
import { fetchDeepSeekBalance } from "./deepseek-balance.js";
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
  });
  ctx.screen.setStatusMeta({
    sessionStartedAt: ctx.session.createdAt.getTime(),
    gitBranch: currentGitBranch(ctx.workspace),
    contextWindowSize,
  });
  ctx.screen.setCostRates(resolveSessionRates(ctx) ?? null);
}

/**
 * Refresh the DeepSeek account balance shown on the StatusLine's second row.
 * No-op (clears nothing) unless the base URL points at DeepSeek's official API;
 * best-effort and self-contained — `fetchDeepSeekBalance` swallows its own
 * errors and returns null, which `setAccountBalance` treats as "hide". Always
 * call fire-and-forget so a slow request never delays a turn.
 */
export async function refreshBalance(ctx: CliContext): Promise<void> {
  const balance = await fetchDeepSeekBalance(ctx.settings);
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

/** Default spinner hint shown while a turn / tool is running. */
export const INTERRUPT_HINT = "esc to interrupt";

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
      { words: WORKING_WORDS, tint: ACCENT_RGB, colorize: accent },
      INTERRUPT_HINT,
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
