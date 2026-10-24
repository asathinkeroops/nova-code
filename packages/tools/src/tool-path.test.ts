import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editTool, globTool, grepTool, readTool, writeTool } from "./index.js";

/**
 * WT17 — a tool must read/write the SAME file the permission gate approved.
 *
 * The gate, the read-before-edit ledger, the dispatcher's execution key and the
 * snapshot store all canonicalize a tool path with `canonicalizePath` (OS
 * traversal: follow the symlink, THEN apply `..`). A tool that re-resolved with
 * `path.resolve` folded `..` lexically and hit a different file:
 *
 *   <main>/worktree-link/../victim.txt
 *     gate/ledger/key → <ws>/victim.txt        (inside the workspace)
 *     old `write`     → <main>/victim.txt      (outside it)
 *
 * so an approved in-workspace write overwrote the main checkout. These tests
 * drive the tools directly and assert the file that actually changed.
 */
describe("file tools resolve `..` after symlinks like the gate does (WT17)", () => {
  let base: string;
  let ws: string;
  let outside: string;
  /** A link living OUTSIDE the workspace that points back into it. */
  let raw: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "nova-tool-path-")));
    ws = join(base, "ws");
    outside = join(base, "main");
    await mkdir(join(ws, "sub"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(join(ws, "sub"), join(outside, "worktree-link"));
    await writeFile(join(ws, "victim.txt"), "WORKTREE\n");
    await writeFile(join(outside, "victim.txt"), "MAIN\n");
    await writeFile(join(ws, "ws-only.txt"), "inside\n");
    await writeFile(join(outside, "main-only.txt"), "outside\n");
    // NB: build by concatenation — path.join would fold `..` before the OS sees it.
    raw = `${outside}/worktree-link/../victim.txt`;
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("write overwrites the workspace file, not the one the literal path names", async () => {
    const res = await writeTool.run({ path: raw, content: "OVERWRITTEN\n" }, { cwd: ws });
    expect(res.isError).toBeUndefined();
    expect(String(res.output)).toContain(join(ws, "victim.txt"));
    expect(await readFile(join(ws, "victim.txt"), "utf8")).toBe("OVERWRITTEN\n");
    // The file the LEXICAL `..` fold named is untouched.
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("MAIN\n");
  });

  it("edit modifies the workspace file", async () => {
    const res = await editTool.run(
      { path: raw, old_string: "WORKTREE", new_string: "EDITED" },
      { cwd: ws },
    );
    expect(res.isError).toBeUndefined();
    expect(await readFile(join(ws, "victim.txt"), "utf8")).toBe("EDITED\n");
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("MAIN\n");
  });

  it("read returns the workspace file's contents", async () => {
    const res = await readTool.run({ path: raw }, { cwd: ws });
    expect(res.isError).toBeUndefined();
    expect(String(res.output)).toContain("WORKTREE");
    expect(String(res.output)).not.toContain("MAIN");
  });

  it("glob searches the workspace directory", async () => {
    const res = await globTool.run(
      { pattern: "*.txt", path: `${outside}/worktree-link/..` },
      { cwd: ws },
    );
    const out = String(res.output);
    expect(out).toContain("ws-only.txt");
    expect(out).not.toContain("main-only.txt");
  });

  it("grep searches the workspace directory", async () => {
    const res = await grepTool.run(
      { pattern: "WORKTREE", path: `${outside}/worktree-link/..` },
      { cwd: ws },
    );
    expect(String(res.output)).toContain("WORKTREE");
    const miss = await grepTool.run(
      { pattern: "outside", path: `${outside}/worktree-link/..` },
      { cwd: ws },
    );
    expect(String(miss.output)).not.toContain("main-only.txt");
  });

  it("write follows a final dangling symlink to the file the OS creates", async () => {
    // The OS follows the link and creates its target; reporting (and checking)
    // the link path instead would approve a file the write never touches.
    await mkdir(join(base, "target"));
    await symlink(join(base, "target", "new.txt"), join(ws, "dangling.txt"));
    const res = await writeTool.run(
      { path: join(ws, "dangling.txt"), content: "made\n" },
      { cwd: ws },
    );
    expect(res.isError).toBeUndefined();
    expect(String(res.output)).toContain(join(base, "target", "new.txt"));
    expect(await readFile(join(base, "target", "new.txt"), "utf8")).toBe("made\n");
  });
});
