import { parseSettings } from "@nova/runtime";
import { PermissionEngine } from "@nova/safety";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_RULES,
  resolvePermissionRules,
  workspaceReadRules,
} from "./permissions.js";

const CWD = "/Users/me/work/proj";

describe("resolvePermissionRules", () => {
  it("prepends workspace read rules ahead of the static defaults", () => {
    const settings = parseSettings({});
    const merged = resolvePermissionRules(settings, CWD);
    expect(merged.slice(0, 2)).toEqual(workspaceReadRules(CWD));
    expect(merged.slice(2)).toEqual([...DEFAULT_PERMISSION_RULES]);
  });

  it("places user rules before workspace rules so they win on first-match", () => {
    const settings = parseSettings({
      permissions: {
        defaultEffect: "ask",
        rules: [{ tool: "read", effect: "ask" }],
      },
    });
    const merged = resolvePermissionRules(settings, CWD);
    expect(merged[0]).toEqual({ tool: "read", effect: "ask" });
    expect(merged).toContainEqual({ tool: "grep", effect: "allow" });
  });

  it("static default list covers safe read-only builtins (read is workspace-scoped, not here)", () => {
    const tools = DEFAULT_PERMISSION_RULES.map((r) => r.tool).sort();
    expect(tools).toEqual(
      ["ask_user_question", "createTodo", "getTodos", "glob", "grep", "updateTodo"].sort(),
    );
    expect(tools).not.toContain("read");
  });
});

describe("workspace-scoped read", () => {
  function engine(extraUserRules: Parameters<typeof parseSettings>[0] = {}) {
    const settings = parseSettings(extraUserRules);
    return new PermissionEngine({
      defaultEffect: settings.permissions.defaultEffect,
      rules: resolvePermissionRules(settings, CWD),
    });
  }

  it("allows cwd-relative paths with no `..`", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "read", input: { path: "src/foo.ts" } }).effect).toBe("allow");
    expect(eng.evaluate({ tool: "read", input: { path: "README.md" } }).effect).toBe("allow");
    expect(eng.evaluate({ tool: "read", input: { path: "a/b/c.txt" } }).effect).toBe("allow");
  });

  it("allows absolute paths under cwd", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "read", input: { path: `${CWD}/src/foo.ts` } }).effect).toBe(
      "allow",
    );
    expect(eng.evaluate({ tool: "read", input: { path: CWD } }).effect).toBe("allow");
  });

  it("falls through to ask for relative paths that traverse via `..`", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "read", input: { path: "../sibling/x" } }).effect).toBe("ask");
    expect(eng.evaluate({ tool: "read", input: { path: "src/../../etc/passwd" } }).effect).toBe(
      "ask",
    );
    expect(eng.evaluate({ tool: "read", input: { path: ".." } }).effect).toBe("ask");
    expect(eng.evaluate({ tool: "read", input: { path: "foo/.." } }).effect).toBe("ask");
  });

  it("does not treat `..` substrings inside filenames as traversal", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "read", input: { path: "foo..bar.txt" } }).effect).toBe("allow");
  });

  it("falls through to ask for absolute paths outside cwd", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "read", input: { path: "/etc/passwd" } }).effect).toBe("ask");
    expect(eng.evaluate({ tool: "read", input: { path: "/Users/me/other/x" } }).effect).toBe(
      "ask",
    );
  });

  it("does not match sibling dirs with the cwd as a prefix", () => {
    const eng = engine();
    expect(eng.evaluate({ tool: "read", input: { path: `${CWD}-other/x` } }).effect).toBe("ask");
  });
});
