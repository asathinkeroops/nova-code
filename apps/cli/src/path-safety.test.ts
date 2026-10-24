import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeGateInput, PATH_INPUT_TOOLS } from "./path-safety.js";

// canonicalizePath / canonicalizeRoots behavior (`..` folding, symlink
// resolution, nearest-ancestor for write targets) is covered in
// @nova/base's path-safety.test.ts, where the shared logic now lives.
describe("PATH_INPUT_TOOLS", () => {
  it("lists the path-bearing builtins gated before a permission decision", () => {
    // read/write/edit touch the file; glob/grep use `path` as the search root.
    expect([...PATH_INPUT_TOOLS].sort()).toEqual(["edit", "glob", "grep", "read", "write"]);
  });
});

describe("canonicalizeGateInput — shell cwd", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "nova-gate-cwd-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves a relative cwd against the workspace, matching what the tool executes", async () => {
    const gated = await canonicalizeGateInput("bash", { command: "pwd", cwd: "." }, root);
    expect(gated.cwd).toBe(root);

    const sub = await canonicalizeGateInput("monitor", { command: "ls", cwd: "sub" }, root);
    expect(sub.cwd).toBe(join(root, "sub"));
  });

  it("resolves a symlinked cwd so it cannot redirect the command elsewhere", async () => {
    const outside = join(root, "outside");
    const session = join(root, "session");
    await mkdir(outside);
    await mkdir(session);
    await symlink(outside, join(session, "link"));

    const gated = await canonicalizeGateInput("bash", { command: "pwd", cwd: "link" }, session);
    expect(gated.cwd).toBe(outside);
  });

  it("leaves tools without a cwd untouched", async () => {
    const input = { command: "pwd" };
    expect(await canonicalizeGateInput("bash", input, root)).toBe(input);
    const other = { url: "https://example.com" };
    expect(await canonicalizeGateInput("webfetch", other, root)).toBe(other);
  });
});
