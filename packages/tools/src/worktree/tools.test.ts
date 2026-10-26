import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "@nova/core";
import {
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  WORKTREE_PROMPT,
  createWorktreeTools,
  type WorktreeHost,
} from "./index.js";
import { renderToolPrompts } from "../prompt.js";

const toolCtx = { cwd: "/repo" };

function definition(name: string): ToolDefinition {
  return { name, description: "", inputSchema: z.object({}) };
}

function makeHost(overrides: Partial<WorktreeHost> = {}): WorktreeHost {
  return {
    enter: vi.fn(async () => ({
      path: "/repo/.nova/worktrees/fix",
      branch: "worktree-fix",
      main: "/repo",
      created: true,
      copied: 0,
      skipped: 0,
      failed: 0,
    })),
    exit: vi.fn(async () => ({ path: "/repo" })),
    ...overrides,
  };
}

function tool(host: WorktreeHost, name: string) {
  const found = createWorktreeTools(host).find((t) => t.definition.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("enterWorktree tool", () => {
  it("enters by name and reports the checkout", async () => {
    const host = makeHost({
      enter: vi.fn(async () => ({
        path: "/repo/.nova/worktrees/fix",
        branch: "worktree-fix",
        main: "/repo",
        created: true,
        copied: 2,
        skipped: 1,
        failed: 0,
      })),
    });
    const result = await tool(host, ENTER_WORKTREE_TOOL_NAME).run({ name: "fix" }, toolCtx);

    expect(host.enter).toHaveBeenCalledWith({ name: "fix" });
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("Entered worktree /repo/.nova/worktrees/fix");
    expect(result.output).toContain("Branch: worktree-fix");
    expect(result.output).toContain("Main checkout: /repo");
    expect(result.output).toContain("fresh checkout");
    expect(result.output).toContain("Copied 2");
    expect(result.output).toContain("skipped 1");
  });

  it("enters by path", async () => {
    const host = makeHost({
      enter: vi.fn(async () => ({
        path: "/repo/.nova/worktrees/fix",
        created: false,
        alreadyHere: true,
      })),
    });
    const result = await tool(host, ENTER_WORKTREE_TOOL_NAME).run(
      {
        path: ".nova/worktrees/fix",
      },
      toolCtx,
    );

    expect(host.enter).toHaveBeenCalledWith({ path: ".nova/worktrees/fix" });
    expect(result.output).toContain("Already in worktree");
  });

  it("rejects ambiguous or invalid combinations at the schema", () => {
    const schema = tool(makeHost(), ENTER_WORKTREE_TOOL_NAME).definition.inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ name: "a", path: "/repo/.nova/worktrees/a" }).success).toBe(false);
    expect(schema.safeParse({ path: "/repo/.nova/worktrees/a", from: "main" }).success).toBe(false);
    expect(schema.safeParse({ name: "a", from: "main" }).success).toBe(true);
    expect(schema.safeParse({ path: "/repo/.nova/worktrees/a" }).success).toBe(true);
  });

  it("surfaces a host error as an error result", async () => {
    const host = makeHost({
      enter: vi.fn(async () => {
        throw new Error("worktrees are disabled");
      }),
    });
    const result = await tool(host, ENTER_WORKTREE_TOOL_NAME).run({ name: "fix" }, toolCtx);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("enterWorktree failed: worktrees are disabled");
  });
});

describe("exitWorktree tool", () => {
  it("exits and reports the new workspace", async () => {
    const host = makeHost();
    const result = await tool(host, EXIT_WORKTREE_TOOL_NAME).run({}, toolCtx);

    expect(host.exit).toHaveBeenCalledWith({});
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("back in /repo");
  });

  it("passes an explicit main-checkout path through", async () => {
    const host = makeHost({
      exit: vi.fn(async () => ({ path: "/repo" })),
    });
    await tool(host, EXIT_WORKTREE_TOOL_NAME).run({ path: "/repo" }, toolCtx);
    expect(host.exit).toHaveBeenCalledWith({ path: "/repo" });
  });

  it("surfaces a host error as an error result", async () => {
    const host = makeHost({
      exit: vi.fn(async () => {
        throw new Error("this session is not in a worktree");
      }),
    });
    const result = await tool(host, EXIT_WORKTREE_TOOL_NAME).run({}, toolCtx);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("exitWorktree failed");
  });
});

describe("worktree tool definitions", () => {
  it("marks both switches exclusive and serialized", () => {
    for (const handler of createWorktreeTools(makeHost())) {
      expect(handler.definition.exclusive).toBe(true);
      expect(handler.executionKey?.({}, { cwd: "/repo" })).toBe("session-workspace");
    }
  });
});

describe("WORKTREE_PROMPT", () => {
  it("renders only the tools that survived the host's denylist", () => {
    const enterOnly = renderToolPrompts([definition(ENTER_WORKTREE_TOOL_NAME)], [WORKTREE_PROMPT]);
    expect(enterOnly.text).toContain(ENTER_WORKTREE_TOOL_NAME);
    expect(enterOnly.text).not.toContain(EXIT_WORKTREE_TOOL_NAME);
    expect(enterOnly.text).toContain("Do not run `git worktree add`");

    const both = renderToolPrompts(
      [definition(ENTER_WORKTREE_TOOL_NAME), definition(EXIT_WORKTREE_TOOL_NAME)],
      [WORKTREE_PROMPT],
    );
    expect(both.text).toContain(ENTER_WORKTREE_TOOL_NAME);
    expect(both.text).toContain(EXIT_WORKTREE_TOOL_NAME);

    const none = renderToolPrompts([definition("read")], [WORKTREE_PROMPT]);
    expect(none.text).toBe("");
  });
});
