import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@nova/base";
import { describe, expect, it, vi } from "vitest";
import {
  persist,
  refreshBanner,
  refreshTaskFooter,
  refreshTodoFooter,
  startWorkingSpinner,
  stopSpinner,
  thinkingLevelLabel,
} from "./ctx-runtime.js";
import type { CliContext } from "./ctx-types.js";

/**
 * Build a mutable partial CliContext. Only the fields a given test touches need
 * to be set; everything else is left undefined and the whole thing is cast.
 * The object is intentionally a real mutable JS object so the spinner helpers
 * can read/write `ctx.spinner` in place.
 */
function makeCtx(partial: Partial<CliContext> = {}): CliContext {
  return { spinner: null, ...partial } as unknown as CliContext;
}

describe("thinkingLevelLabel", () => {
  it("is undefined when thinking is off", () => {
    const ctx = makeCtx({ thinkingLevel: "off" });
    expect(thinkingLevelLabel(ctx)).toBeUndefined();
  });

  it("shows an explicit level", () => {
    const ctx = makeCtx({ thinkingLevel: "high" });
    expect(thinkingLevelLabel(ctx)).toBe("high");
  });

  it("shows auto when the endpoint default is selected", () => {
    const ctx = makeCtx({ thinkingLevel: "auto" });
    expect(thinkingLevelLabel(ctx)).toBe("auto");
  });
});

describe("stopSpinner", () => {
  it("is a no-op when no spinner is running", () => {
    const ctx = makeCtx();
    expect(() => stopSpinner(ctx)).not.toThrow();
    expect(ctx.spinner).toBeNull();
  });
});

describe("startWorkingSpinner", () => {
  it("starts the spinner anchored to taskStartedAt when idle", () => {
    const stop = vi.fn();
    const startSpinner = vi.fn(() => ({ stop }));
    const ctx = makeCtx({
      taskStartedAt: 1_000,
      screen: { startSpinner } as unknown as CliContext["screen"],
    });
    startWorkingSpinner(ctx);
    expect(startSpinner).toHaveBeenCalledOnce();
    expect(startSpinner).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1_000,
    );
    expect(ctx.spinner).not.toBeNull();
  });

  it("is a no-op when a spinner is already running", () => {
    const stop = vi.fn();
    const startSpinner = vi.fn(() => ({ stop }));
    const ctx = makeCtx({
      taskStartedAt: 1_000,
      spinner: { stop } as unknown as CliContext["spinner"],
      screen: { startSpinner } as unknown as CliContext["screen"],
    });
    startWorkingSpinner(ctx);
    expect(startSpinner).not.toHaveBeenCalled();
  });

  it("seeds taskStartedAt when it is still null", () => {
    const stop = vi.fn();
    const startSpinner = vi.fn(() => ({ stop }));
    const ctx = makeCtx({
      screen: { startSpinner } as unknown as CliContext["screen"],
    });
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    startWorkingSpinner(ctx);
    expect(ctx.taskStartedAt).toBe(5_000);
    expect(startSpinner).toHaveBeenCalledOnce();
    vi.useRealTimers();
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
          profile: "generic",
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
