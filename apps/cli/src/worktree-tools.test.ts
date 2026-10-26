import { describe, expect, it, vi } from "vitest";
import type { ToolHandler } from "@nova/core";
import { ENTER_WORKTREE_TOOL_NAME, EXIT_WORKTREE_TOOL_NAME } from "@nova/tools";
import type { CliContext } from "./ctx-types.js";
import type { AddWorktreeOptions, AddWorktreeResult, WorktreeBinding } from "./worktree.js";
import {
  createWorktreeHost,
  registerWorktreeTools,
  type WorktreeToolDeps,
} from "./worktree-tools.js";

function binding(path: string): WorktreeBinding {
  return {
    path,
    branch: "worktree-fix",
    main: "/repo",
    gitDir: "/repo/.git",
    checkouts: [],
  };
}

function makeCtx(
  overrides: Partial<{
    workspace: string;
    worktree: WorktreeBinding | null;
    enabled: boolean;
  }> = {},
) {
  const ctx = {} as CliContext;
  const setWorkspace = vi.fn(async (path: string) => {
    ctx.workspace = path;
    if (path === "/repo") {
      ctx.worktree = null;
      return null;
    }
    const next = binding(path);
    ctx.worktree = next;
    return next;
  });
  const registerAll = vi.fn();
  Object.assign(ctx, {
    workspace: overrides.workspace ?? "/repo",
    worktree: overrides.worktree ?? null,
    settings: {
      worktree: {
        enabled: overrides.enabled ?? true,
        dir: ".nova/worktrees",
        baseRef: "fresh",
        includeFile: ".worktreeinclude",
      },
    },
    setWorkspace,
    tools: { registerAll },
  });
  return { ctx, setWorkspace, registerAll };
}

function makeDeps() {
  const addWorktree = vi.fn(
    async (opts: AddWorktreeOptions): Promise<AddWorktreeResult> => ({
      path: `/repo/${opts.dir}/${opts.name}`,
      branch: `worktree-${opts.name}`,
      created: true,
      copied: 1,
      skipped: 0,
      failed: 0,
    }),
  );
  const worktreeBinding = vi.fn(async (dir: string) =>
    dir === "/repo" ? undefined : binding(dir),
  );
  const repoRoot = vi.fn(async (dir: string) => dir);
  return {
    addWorktree,
    worktreeBinding,
    repoRoot,
  } as unknown as WorktreeToolDeps;
}

describe("createWorktreeHost", () => {
  it("enters by name through addWorktree and setWorkspace", async () => {
    const { ctx, setWorkspace } = makeCtx();
    const deps = makeDeps();
    const host = createWorktreeHost(ctx, deps);

    const result = await host.enter({ name: "fix" });

    expect(deps.addWorktree).toHaveBeenCalledWith({
      repo: "/repo",
      name: "fix",
      dir: ".nova/worktrees",
      baseRef: "fresh",
      includeFile: ".worktreeinclude",
    });
    expect(setWorkspace).toHaveBeenCalledWith("/repo/.nova/worktrees/fix");
    expect(result).toMatchObject({
      path: "/repo/.nova/worktrees/fix",
      branch: "worktree-fix",
      main: "/repo",
      created: true,
    });
  });

  it("enters an existing worktree by path", async () => {
    const { ctx, setWorkspace } = makeCtx();
    const deps = makeDeps();
    const host = createWorktreeHost(ctx, deps);

    const result = await host.enter({ path: "/repo/.nova/worktrees/fix" });

    expect(deps.worktreeBinding).toHaveBeenCalledWith("/repo/.nova/worktrees/fix");
    expect(setWorkspace).toHaveBeenCalledWith("/repo/.nova/worktrees/fix");
    expect(result.created).toBe(false);
    expect(result.alreadyHere).toBeUndefined();
  });

  it("reports already-here without moving the session", async () => {
    const { ctx, setWorkspace } = makeCtx({
      workspace: "/repo/.nova/worktrees/fix",
      worktree: binding("/repo/.nova/worktrees/fix"),
    });
    const host = createWorktreeHost(ctx, makeDeps());

    const result = await host.enter({ path: "/repo/.nova/worktrees/fix" });

    expect(result.alreadyHere).toBe(true);
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it("reports already-here when the named worktree is the current one", async () => {
    const { ctx, setWorkspace } = makeCtx({
      workspace: "/repo/.nova/worktrees/fix",
      worktree: binding("/repo/.nova/worktrees/fix"),
    });
    const host = createWorktreeHost(ctx, makeDeps());

    const result = await host.enter({ name: "fix" });

    expect(result.alreadyHere).toBe(true);
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it("rejects the main checkout (exit is a different tool)", async () => {
    const { ctx } = makeCtx();
    const host = createWorktreeHost(ctx, makeDeps());

    await expect(host.enter({ path: "/repo" })).rejects.toThrow(/not a linked worktree/);
  });

  it("rejects when worktrees are disabled", async () => {
    const { ctx } = makeCtx({ enabled: false });
    const host = createWorktreeHost(ctx, makeDeps());

    await expect(host.enter({ name: "fix" })).rejects.toThrow(/disabled/);
  });

  it("exits to the recorded main checkout", async () => {
    const worktree = binding("/repo/.nova/worktrees/fix");
    const { ctx, setWorkspace } = makeCtx({
      workspace: worktree.path,
      worktree,
    });
    const host = createWorktreeHost(ctx, makeDeps());

    const result = await host.exit({});

    expect(setWorkspace).toHaveBeenCalledWith("/repo");
    expect(result).toEqual({ path: "/repo" });
  });

  it("exits to an explicit checkout root when main is unknown", async () => {
    const worktree = { ...binding("/repo/.nova/worktrees/fix"), main: undefined };
    const { ctx, setWorkspace } = makeCtx({
      workspace: worktree.path,
      worktree,
    });
    const host = createWorktreeHost(ctx, makeDeps());

    const result = await host.exit({ path: "/repo" });

    expect(setWorkspace).toHaveBeenCalledWith("/repo");
    expect(result).toEqual({ path: "/repo" });
  });

  it("refuses to exit from a session that is not in a worktree", async () => {
    const { ctx } = makeCtx();
    const host = createWorktreeHost(ctx, makeDeps());

    await expect(host.exit({})).rejects.toThrow(/not in a worktree/);
  });

  it("refuses to exit to another linked worktree", async () => {
    const worktree = binding("/repo/.nova/worktrees/fix");
    const { ctx } = makeCtx({ workspace: worktree.path, worktree });
    const deps = makeDeps();
    (deps.worktreeBinding as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      binding("/repo/.nova/worktrees/other"),
    );
    const host = createWorktreeHost(ctx, deps);

    await expect(host.exit({ path: "/repo/.nova/worktrees/other" })).rejects.toThrow(
      /use enterWorktree/,
    );
  });

  it("refuses to exit to a subdirectory rather than a checkout root", async () => {
    const worktree = binding("/repo/.nova/worktrees/fix");
    const { ctx } = makeCtx({ workspace: worktree.path, worktree });
    const deps = makeDeps();
    (deps.repoRoot as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("/repo");
    const host = createWorktreeHost(ctx, deps);

    await expect(host.exit({ path: "/repo/sub" })).rejects.toThrow(/not a checkout root/);
  });
});

describe("registerWorktreeTools", () => {
  it("registers both tools when worktrees are enabled", () => {
    const { ctx, registerAll } = makeCtx();
    registerWorktreeTools(ctx);

    const handlers = registerAll.mock.calls[0]?.[0] as ToolHandler[];
    expect(handlers.map((h) => h.definition.name)).toEqual([
      ENTER_WORKTREE_TOOL_NAME,
      EXIT_WORKTREE_TOOL_NAME,
    ]);
  });

  it("registers nothing when worktrees are disabled", () => {
    const { ctx, registerAll } = makeCtx({ enabled: false });
    registerWorktreeTools(ctx);
    expect(registerAll).not.toHaveBeenCalled();
  });
});
