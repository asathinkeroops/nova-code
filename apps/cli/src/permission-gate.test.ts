import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSettings } from "@nova/base";
import { PermissionEngine } from "@nova/safety";
import { readTool, writeTool } from "@nova/tools";
import { canonicalizeGateInput, canonicalizePath, canonicalizeRoots } from "./path-safety.js";
import { resolveModeDecision, resolvePermissionRules } from "./permissions.js";

/**
 * Regression suite for the permission gate's path resolution.
 *
 * The gate runs BEFORE the dispatcher validates a tool input, while the
 * `filePath`/`file_path`/`file` aliases are only normalized inside the tool
 * schema (downstream). Reading `input.path` directly therefore saw an
 * alias-only call as "no path", fell back to "." — the workspace root — and
 * granted it as an in-workspace operation, after which the dispatcher executed
 * it against the real out-of-workspace target. The gate now resolves the path
 * through `aliasedPath`, so it and the schema agree on the file.
 */
describe("permission gate path resolution", () => {
  let base: string;
  let ws: string;
  let outsideDir: string;
  let roots: string[];

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "nova-gate-"));
    ws = await canonicalizePath(base, "ws");
    outsideDir = await canonicalizePath(base, "outside");
    await mkdir(ws, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "TOP-SECRET", "utf8");
    // The same canonical roots `createContext` builds (workspace cwd is the
    // only root here).
    roots = await canonicalizeRoots([ws], ws);
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function engine(): PermissionEngine {
    const settings = parseSettings({});
    return new PermissionEngine({
      defaultEffect: settings.permissions.defaultEffect,
      rules: resolvePermissionRules(settings, roots),
      ask: async () => "no",
    });
  }

  it("resolves a filePath alias to the real target instead of the workspace root", async () => {
    const target = join(outsideDir, "evil.txt");
    const evalInput = await canonicalizeGateInput(
      "write",
      { filePath: target, content: "owned" },
      ws,
    );
    expect(evalInput.path).toBe(await canonicalizePath(ws, target));
    expect(evalInput.path).not.toBe(ws);
  });

  it("prefers the canonical path when both path and an alias are present", async () => {
    const canonicalTarget = join(ws, "a.txt");
    const evalInput = await canonicalizeGateInput(
      "write",
      { path: canonicalTarget, filePath: join(outsideDir, "b.txt"), content: "x" },
      ws,
    );
    expect(evalInput.path).toBe(await canonicalizePath(ws, canonicalTarget));
  });

  it("does not auto-grant an out-of-workspace write addressed via filePath", async () => {
    const evalInput = await canonicalizeGateInput(
      "write",
      { filePath: join(outsideDir, "evil.txt"), content: "owned" },
      ws,
    );
    // Both write-granting modes must defer to the engine, which asks.
    expect(resolveModeDecision("auto", "write", evalInput.path as string, roots)).toBeNull();
    expect(resolveModeDecision("acceptEdits", "write", evalInput.path as string, roots)).toBeNull();
    expect(engine().evaluate({ tool: "write", input: evalInput }).effect).toBe("ask");
  });

  it("still auto-grants an in-workspace write addressed via filePath", async () => {
    const evalInput = await canonicalizeGateInput(
      "write",
      { filePath: join(ws, "src", "a.ts"), content: "x" },
      ws,
    );
    expect(resolveModeDecision("auto", "write", evalInput.path as string, roots)).toEqual({
      granted: true,
    });
  });

  it("asks for an out-of-workspace read addressed via filePath (all modes)", async () => {
    const evalInput = await canonicalizeGateInput(
      "read",
      { filePath: join(outsideDir, "secret.txt") },
      ws,
    );
    expect(engine().evaluate({ tool: "read", input: evalInput }).effect).toBe("ask");
  });

  it("allows an in-workspace read addressed via filePath", async () => {
    await writeFile(join(ws, "inside.txt"), "ok", "utf8");
    const evalInput = await canonicalizeGateInput("read", { filePath: join(ws, "inside.txt") }, ws);
    expect(engine().evaluate({ tool: "read", input: evalInput }).effect).toBe("allow");
  });

  it("judges the same target the tool schema will execute against", async () => {
    // The gate and the dispatch-time schema must normalize aliases identically;
    // if they ever drift, the gate would decide on one file and the tool touch
    // another. `canonicalizeGateInput` gives the gate path, `withAliases` gives
    // the executed path — compare them for both tools.
    for (const [tool, raw] of [
      ["write", { filePath: join(outsideDir, "evil.txt"), content: "owned" }],
      ["read", { filePath: join(outsideDir, "secret.txt") }],
    ] as const) {
      const handler = tool === "write" ? writeTool : readTool;
      const gatePath = (await canonicalizeGateInput(tool, raw, ws)).path as string;
      const parsed = handler.definition.inputSchema.parse(raw) as { path: string };
      expect(gatePath).toBe(await canonicalizePath(ws, parsed.path));
    }
  });

  it("falls back to the workspace root for a path-less glob/grep", async () => {
    const evalInput = await canonicalizeGateInput("grep", { pattern: "x" }, ws);
    expect(evalInput.path).toBe(ws);
  });

  it("ignores aliases for glob/grep, whose schemas do not accept them", async () => {
    // Their schema is a bare `z.object({ path })`, so `filePath` is stripped and
    // the search root stays the cwd. The gate must mirror that, not canonicalize
    // a directory the call will never search.
    const evalInput = await canonicalizeGateInput(
      "grep",
      { pattern: "x", filePath: join(outsideDir, "secret.txt") },
      ws,
    );
    expect(evalInput.path).toBe(ws);
  });
});
