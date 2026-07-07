import { parseSettings } from "@nova/runtime";
import { PermissionEngine } from "@nova/safety";
import { describe, expect, it } from "vitest";
import {
  autoMemoryRules,
  DEFAULT_PERMISSION_RULES,
  resolveModeDecision,
  resolvePermissionRules,
  workspaceReadRules,
} from "./permissions.js";

const CWD = "/Users/me/work/proj";

describe("resolvePermissionRules", () => {
  it("prepends the workspace read rules ahead of the static defaults", () => {
    const settings = parseSettings({});
    const ws = workspaceReadRules([CWD]);
    const merged = resolvePermissionRules(settings, [CWD]);
    expect(merged.slice(0, ws.length)).toEqual(ws);
    expect(merged.slice(ws.length)).toEqual([...DEFAULT_PERMISSION_RULES]);
  });

  it("fences read, glob, and grep on path containment", () => {
    expect(workspaceReadRules([CWD]).map((r) => r.tool)).toEqual(["read", "glob", "grep"]);
  });

  it("places user rules before the workspace rules so they win on first-match", () => {
    const settings = parseSettings({
      permissions: {
        defaultEffect: "ask",
        rules: [{ tool: "read", effect: "ask" }],
      },
    });
    const merged = resolvePermissionRules(settings, [CWD]);
    expect(merged[0]).toEqual({ tool: "read", effect: "ask" });
    expect(merged).toContainEqual({ tool: "loadSkill", effect: "allow" });
  });

  it("static default list covers safe builtins (read/glob/grep are workspace-scoped, not here)", () => {
    const tools = DEFAULT_PERMISSION_RULES.map((r) => r.tool).sort();
    expect(tools).toEqual(
      [
        "askUserQuestion",
        "clearTaskList",
        "clearTodoList",
        "createSubAgent",
        "createTask",
        "createTodo",
        "getBackgroundOutput",
        "getTaskList",
        "getTodoList",
        "killBackground",
        "loadSkill",
        "lsp",
        "updateTask",
        "updateTodo",
        "webfetch",
        "websearch",
      ].sort(),
    );
    // Path-fenced read-only tools must not be flat-allowed here.
    expect(tools).not.toContain("read");
    expect(tools).not.toContain("glob");
    expect(tools).not.toContain("grep");
  });
});

describe("auto-memory rules", () => {
  const MEM = `${CWD}/.nova/memory`;

  it("auto-allows read/write/edit scoped to the memory dir", () => {
    expect(autoMemoryRules(MEM)).toEqual([
      { tool: "read", effect: "allow", match: { path: { within: [MEM] } } },
      { tool: "write", effect: "allow", match: { path: { within: [MEM] } } },
      { tool: "edit", effect: "allow", match: { path: { within: [MEM] } } },
    ]);
  });

  it("is omitted when no auto-memory dir is passed (default call sig unchanged)", () => {
    const settings = parseSettings({});
    const ws = workspaceReadRules([CWD]);
    const merged = resolvePermissionRules(settings, [CWD]);
    expect(merged.slice(0, ws.length)).toEqual(ws);
    expect(merged.slice(ws.length)).toEqual([...DEFAULT_PERMISSION_RULES]);
  });

  it("inserts memory rules after user rules and before workspace read rules", () => {
    const settings = parseSettings({});
    const merged = resolvePermissionRules(settings, [CWD], MEM);
    const mem = autoMemoryRules(MEM);
    expect(merged.slice(0, mem.length)).toEqual(mem);
  });

  it("lets the engine auto-allow write/edit inside the memory dir but still ask outside", () => {
    const settings = parseSettings({});
    const eng = new PermissionEngine({
      defaultEffect: settings.permissions.defaultEffect,
      rules: resolvePermissionRules(settings, [CWD], MEM),
    });
    expect(eng.evaluate({ tool: "write", input: { path: `${MEM}/fact.md` } }).effect).toBe("allow");
    expect(eng.evaluate({ tool: "edit", input: { path: `${MEM}/MEMORY.md` } }).effect).toBe("allow");
    // A write elsewhere in the workspace still prompts (prompt-on-write default).
    expect(eng.evaluate({ tool: "write", input: { path: `${CWD}/src/foo.ts` } }).effect).toBe("ask");
  });

  it("lets a user rule force memory writes back to ask (first-match wins)", () => {
    const settings = parseSettings({
      permissions: { defaultEffect: "ask", rules: [{ tool: "write", effect: "ask" }] },
    });
    const eng = new PermissionEngine({
      defaultEffect: settings.permissions.defaultEffect,
      rules: resolvePermissionRules(settings, [CWD], MEM),
    });
    expect(eng.evaluate({ tool: "write", input: { path: `${MEM}/fact.md` } }).effect).toBe("ask");
  });
});

// These exercise the engine the way the CLI does AFTER canonicalization: the
// `path` reaching the engine is already an absolute, resolved + realpath'd
// string (see context.ts checkPermission / path-safety.ts). `..` folding and
// symlink resolution are covered in path-safety.test.ts.
describe("workspace-scoped read", () => {
  function engine(
    roots: string[] = [CWD],
    extraUserRules: Parameters<typeof parseSettings>[0] = {},
  ) {
    const settings = parseSettings(extraUserRules);
    return new PermissionEngine({
      defaultEffect: settings.permissions.defaultEffect,
      rules: resolvePermissionRules(settings, roots),
    });
  }

  it("allows canonical paths inside the workspace", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "read", input: { path: `${CWD}/src/foo.ts` } }).effect).toBe(
      "allow",
    );
    expect(eng.evaluate({ tool: "read", input: { path: `${CWD}/a/b/c.txt` } }).effect).toBe(
      "allow",
    );
    expect(eng.evaluate({ tool: "read", input: { path: CWD } }).effect).toBe("allow");
  });

  it("asks for canonical paths outside the workspace", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "read", input: { path: "/etc/passwd" } }).effect).toBe("ask");
    expect(eng.evaluate({ tool: "read", input: { path: "/Users/me/other/x" } }).effect).toBe("ask");
  });

  it("does not match sibling dirs with the cwd as a prefix", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "read", input: { path: `${CWD}-other/x` } }).effect).toBe("ask");
  });

  it("allows paths inside a configured additional directory", () => {
    const extra = "/Users/me/shared";
    const eng = engine([CWD, extra]);
    expect(eng.evaluate({ tool: "read", input: { path: `${extra}/lib/x.ts` } }).effect).toBe(
      "allow",
    );
    expect(eng.evaluate({ tool: "read", input: { path: "/Users/me/shared-x/y" } }).effect).toBe(
      "ask",
    );
  });

  it("does not auto-allow write/edit even inside the workspace (prompt-on-write default)", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "write", input: { path: `${CWD}/src/foo.ts` } }).effect).toBe(
      "ask",
    );
    expect(eng.evaluate({ tool: "edit", input: { path: `${CWD}/src/foo.ts` } }).effect).toBe("ask");
  });

  // glob/grep are fenced like read. checkPermission injects the canonical cwd
  // for an absent `path`, so a path-less (whole-workspace) search lands inside a
  // root and allows; an explicit out-of-tree search root falls through to ask.
  it("allows glob/grep whose search root is inside the workspace", () => {
    const eng = engine();
    expect(
      eng.evaluate({ tool: "glob", input: { pattern: "**/*.ts", path: `${CWD}/src` } }).effect,
    ).toBe("allow");
    expect(eng.evaluate({ tool: "grep", input: { pattern: "x", path: CWD } }).effect).toBe("allow");
  });

  it("asks for glob/grep whose search root is outside the workspace", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "glob", input: { pattern: "**", path: "/etc" } }).effect).toBe(
      "ask",
    );
    expect(
      eng.evaluate({ tool: "grep", input: { pattern: "x", path: "/Users/me/other" } }).effect,
    ).toBe("ask");
  });
});

// The mode branch the CLI applies in checkPermission AFTER canonicalization and
// BEFORE the engine. A null decision means "defer to the engine"; a concrete
// {granted} short-circuits it.
describe("resolveModeDecision", () => {
  const roots = [CWD];

  it("defers entirely in default mode (engine decides)", () => {
    for (const tool of ["write", "edit", "bash", "read"]) {
      expect(resolveModeDecision("default", tool, `${CWD}/x`, roots)).toBeNull();
    }
  });

  it("plan mode denies write/edit/bash with a read-only reason", () => {
    for (const tool of ["write", "edit", "bash"]) {
      const d = resolveModeDecision("plan", tool, `${CWD}/x`, roots);
      expect(d?.granted).toBe(false);
      expect(d?.reason).toMatch(/plan mode/i);
    }
  });

  it("plan mode leaves read-only tools to the engine", () => {
    for (const tool of ["read", "glob", "grep", "lsp"]) {
      expect(resolveModeDecision("plan", tool, `${CWD}/x`, roots)).toBeNull();
    }
  });

  it("accept-edits auto-grants in-workspace write/edit", () => {
    expect(resolveModeDecision("acceptEdits", "write", `${CWD}/src/a.ts`, roots)).toEqual({
      granted: true,
    });
    expect(resolveModeDecision("acceptEdits", "edit", CWD, roots)).toEqual({ granted: true });
  });

  it("accept-edits defers (asks) for out-of-workspace write/edit", () => {
    expect(resolveModeDecision("acceptEdits", "write", "/etc/hosts", roots)).toBeNull();
    expect(resolveModeDecision("acceptEdits", "edit", `${CWD}-sibling/x`, roots)).toBeNull();
  });

  it("accept-edits never auto-grants bash (still asks)", () => {
    expect(resolveModeDecision("acceptEdits", "bash", undefined, roots)).toBeNull();
  });

  it("accept-edits honors additional roots and defers when path is missing", () => {
    const extra = "/Users/me/shared";
    expect(resolveModeDecision("acceptEdits", "write", `${extra}/x`, [CWD, extra])).toEqual({
      granted: true,
    });
    expect(resolveModeDecision("acceptEdits", "write", undefined, roots)).toBeNull();
  });

  it("auto auto-grants in-workspace write/edit like accept-edits", () => {
    expect(resolveModeDecision("auto", "write", `${CWD}/src/a.ts`, roots)).toEqual({
      granted: true,
    });
    expect(resolveModeDecision("auto", "edit", CWD, roots)).toEqual({ granted: true });
  });

  it("auto defers (asks) for out-of-workspace write/edit", () => {
    expect(resolveModeDecision("auto", "write", "/etc/hosts", roots)).toBeNull();
    expect(resolveModeDecision("auto", "edit", `${CWD}-sibling/x`, roots)).toBeNull();
  });

  it("auto defers the command tools to the async classifier (not decided here)", () => {
    // Command gating in auto mode is async (it may call the model), so it lives
    // in checkPermission, not resolveModeDecision — which returns null here.
    expect(resolveModeDecision("auto", "bash", undefined, roots)).toBeNull();
    expect(resolveModeDecision("auto", "runInBackground", undefined, roots)).toBeNull();
  });

  it("auto leaves read-only tools to the engine", () => {
    for (const tool of ["read", "glob", "grep", "lsp"]) {
      expect(resolveModeDecision("auto", tool, `${CWD}/x`, roots)).toBeNull();
    }
  });
});
