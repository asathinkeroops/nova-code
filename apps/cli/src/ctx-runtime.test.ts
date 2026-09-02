import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@nova/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_SPINNER_DELAY_MS } from "./constants.js";
import {
  armToolSpinner,
  clearToolSpinner,
  currentThinkingBudget,
  persist,
  refreshBanner,
  refreshTaskFooter,
  refreshTodoFooter,
  stopSpinner,
  thinkingLevelLabel,
} from "./ctx-runtime.js";
import type { CliContext } from "./ctx-types.js";

/**
 * Build a mutable partial CliContext. Only the fields a given test touches need
 * to be set; everything else is left undefined and the whole thing is cast.
 * The object is intentionally a real mutable JS object so the spinner helpers
 * can read/write `ctx.spinner` and `ctx.toolSpinnerTimer` in place.
 */
function makeCtx(partial: Partial<CliContext>): CliContext {
  return { spinner: null, toolSpinnerTimer: null, ...partial } as unknown as CliContext;
}

describe("currentThinkingBudget", () => {
  it("maps a named level to its token budget", () => {
    const ctx = makeCtx({ thinkingLevel: "medium", thinkingBudgetOverride: undefined });
    expect(currentThinkingBudget(ctx)).toBe(8_000);
  });

  it("lets a positive override win over the level mapping", () => {
    const ctx = makeCtx({ thinkingLevel: "off", thinkingBudgetOverride: 12_345 });
    expect(currentThinkingBudget(ctx)).toBe(12_345);
  });

  it("returns 0 for the off level with no override", () => {
    const ctx = makeCtx({ thinkingLevel: "off", thinkingBudgetOverride: undefined });
    expect(currentThinkingBudget(ctx)).toBe(0);
  });
});

describe("thinkingLevelLabel", () => {
  it("is undefined when the effective budget is zero", () => {
    const ctx = makeCtx({ thinkingLevel: "off", thinkingBudgetOverride: undefined });
    expect(thinkingLevelLabel(ctx)).toBeUndefined();
  });

  it("shows the bare level name when no override is set", () => {
    const ctx = makeCtx({ thinkingLevel: "high", thinkingBudgetOverride: undefined });
    expect(thinkingLevelLabel(ctx)).toBe("high");
  });

  it("shows a `<n>t` token label when an override is set", () => {
    const ctx = makeCtx({ thinkingLevel: "off", thinkingBudgetOverride: 5_000 });
    expect(thinkingLevelLabel(ctx)).toBe("5000t");
  });

  it("falls back to the level name when the override is non-positive", () => {
    const ctx = makeCtx({ thinkingLevel: "low", thinkingBudgetOverride: 0 });
    expect(thinkingLevelLabel(ctx)).toBe("low");
  });
});

describe("tool spinner lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function spinnerCtx() {
    const stop = vi.fn();
    const startSpinner = vi.fn(() => ({ stop }));
    const ctx = makeCtx({ screen: { startSpinner } as unknown as CliContext["screen"] });
    return { ctx, startSpinner, stop };
  }

  it("starts the spinner only after the delay elapses", () => {
    const { ctx, startSpinner } = spinnerCtx();
    armToolSpinner(ctx);
    expect(startSpinner).not.toHaveBeenCalled();
    expect(ctx.toolSpinnerTimer).not.toBeNull();

    vi.advanceTimersByTime(TOOL_SPINNER_DELAY_MS - 1);
    expect(startSpinner).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(startSpinner).toHaveBeenCalledOnce();
    expect(ctx.spinner).not.toBeNull();
    expect(ctx.toolSpinnerTimer).toBeNull();
  });

  it("re-arming before the delay coalesces to a single spinner", () => {
    const { ctx, startSpinner } = spinnerCtx();
    armToolSpinner(ctx);
    armToolSpinner(ctx);
    vi.advanceTimersByTime(TOOL_SPINNER_DELAY_MS);
    expect(startSpinner).toHaveBeenCalledOnce();
  });

  it("clearToolSpinner before the delay cancels the pending spinner", () => {
    const { ctx, startSpinner } = spinnerCtx();
    armToolSpinner(ctx);
    clearToolSpinner(ctx);
    expect(ctx.toolSpinnerTimer).toBeNull();
    vi.advanceTimersByTime(TOOL_SPINNER_DELAY_MS * 2);
    expect(startSpinner).not.toHaveBeenCalled();
    expect(ctx.spinner).toBeNull();
  });

  it("clearToolSpinner after start stops the running spinner", () => {
    const { ctx, stop } = spinnerCtx();
    armToolSpinner(ctx);
    vi.advanceTimersByTime(TOOL_SPINNER_DELAY_MS);
    expect(ctx.spinner).not.toBeNull();
    clearToolSpinner(ctx);
    expect(stop).toHaveBeenCalledOnce();
    expect(ctx.spinner).toBeNull();
  });

  it("stopSpinner is a no-op when no spinner is running", () => {
    const { ctx } = spinnerCtx();
    expect(() => stopSpinner(ctx)).not.toThrow();
    expect(ctx.spinner).toBeNull();
  });
});

describe("footer refreshers", () => {
  it("pushes the todo list to the screen", () => {
    const setTodos = vi.fn();
    const todos = [{ id: "1", text: "x", status: "pending" }];
    const ctx = makeCtx({
      screen: { setTodos } as unknown as CliContext["screen"],
      todoStore: { list: () => todos } as unknown as CliContext["todoStore"],
    });
    refreshTodoFooter(ctx);
    expect(setTodos).toHaveBeenCalledWith(todos);
  });

  it("awaits the task list before pushing it to the screen", async () => {
    const setTasks = vi.fn();
    const tasks = [{ id: "1", title: "t", status: "pending" }];
    const ctx = makeCtx({
      screen: { setTasks } as unknown as CliContext["screen"],
      taskStore: { list: () => Promise.resolve(tasks) } as unknown as CliContext["taskStore"],
    });
    await refreshTaskFooter(ctx);
    expect(setTasks).toHaveBeenCalledWith(tasks);
  });
});

describe("persist", () => {
  it("delegates to the agent and shows no card on success", async () => {
    const card = vi.fn();
    const ctx = makeCtx({
      agent: { persist: () => Promise.resolve() } as unknown as CliContext["agent"],
      screen: { card } as unknown as CliContext["screen"],
    });
    await persist(ctx);
    expect(card).not.toHaveBeenCalled();
  });

  it("surfaces a persist failure as a warn card without throwing", async () => {
    const card = vi.fn();
    const ctx = makeCtx({
      agent: {
        persist: () => Promise.reject(new Error("disk full")),
      } as unknown as CliContext["agent"],
      screen: { card } as unknown as CliContext["screen"],
    });
    await expect(persist(ctx)).resolves.toBeUndefined();
    expect(card).toHaveBeenCalledWith("disk full", { kind: "warn", title: "persist failed" });
  });
});

describe("refreshBanner", () => {
  it("wires banner/status/cost from ctx and reports a null branch outside a repo", async () => {
    const setBanner = vi.fn();
    const setStatusMeta = vi.fn();
    const setCostRates = vi.fn();
    // A bare temp dir is not a git repo, so currentGitBranch returns null.
    const workspace = await mkdtemp(join(tmpdir(), "nova-ctx-"));
    // The active provider's table must define the full lite/pro/max ladder; the
    // "pro" tier resolves to its concrete id on the status line.
    const settings = parseSettings({
      model: "pro",
      providers: [
        {
          name: "test",
          profile: "other",
          models: {
            lite: { id: "deepseek-v4-flash" },
            pro: { id: "deepseek-v4-pro" },
            max: { id: "deepseek-v4-pro" },
          },
        },
      ],
    });
    const ctx = makeCtx({
      version: "9.9.9",
      workspace,
      settings,
      thinkingLevel: "high",
      thinkingBudgetOverride: undefined,
      session: {
        id: "sess-1",
        createdAt: new Date(0),
      } as unknown as CliContext["session"],
      screen: {
        setBanner,
        setStatusMeta,
        setCostRates,
      } as unknown as CliContext["screen"],
    });

    refreshBanner(ctx);

    expect(setBanner).toHaveBeenCalledOnce();
    const banner = setBanner.mock.calls[0]![0] as Record<string, unknown>;
    expect(banner.version).toBe("9.9.9");
    expect(banner.model).toBe(settings.model);
    // Concrete id the active tier ("pro") resolves to, shown on the status line.
    expect(banner.modelId).toBe("deepseek-v4-pro");
    expect(banner.cwd).toBe(workspace);
    expect(banner.sessionId).toBe("sess-1");
    expect(banner.thinkingLabel).toBe("high");

    expect(setStatusMeta).toHaveBeenCalledOnce();
    const meta = setStatusMeta.mock.calls[0]![0] as Record<string, unknown>;
    expect(meta.gitBranch).toBeNull();
    expect(meta.sessionStartedAt).toBe(0);
    expect(meta.contextWindowSize).toBe(banner.contextWindowSize);

    expect(setCostRates).toHaveBeenCalledOnce();
  });
});
