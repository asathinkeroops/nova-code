import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizePath, canonicalizeRoots } from "./path-safety.js";

// Mirror the permission engine's `within` check so tests assert end-to-end
// containment on canonicalized paths.
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

describe("path-safety", () => {
  let dir: string; // realpath'd workspace root (tmpdir itself is a symlink on macOS)

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "nova-pathsafe-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves a relative path against cwd", async () => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "x");
    expect(await canonicalizePath(dir, "src/a.ts")).toBe(join(dir, "src", "a.ts"));
  });

  it("folds `..` traversal so an escape resolves outside the root", async () => {
    const out = await canonicalizePath(dir, "src/../../escape.txt");
    // dir/src/../../escape.txt -> parent-of-dir/escape.txt (join() normalizes `..`)
    expect(out).toBe(join(dir, "..", "escape.txt"));
    expect(isWithin(dir, out)).toBe(false);
  });

  it("resolves a symlinked directory to its real target (symlink escape is caught)", async () => {
    // dir/link -> /etc (an out-of-tree real directory). Reading link/passwd
    // must canonicalize to the real /etc/passwd, which is NOT within dir.
    const real = await realpath("/etc");
    await symlink(real, join(dir, "link"));
    const out = await canonicalizePath(dir, "link/passwd");
    expect(out).toBe(join(real, "passwd"));
    expect(isWithin(dir, out)).toBe(false);
  });

  it("keeps an in-tree symlink target inside the root", async () => {
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    const out = await canonicalizePath(dir, "link/file.ts");
    expect(out).toBe(join(dir, "real", "file.ts"));
    expect(isWithin(dir, out)).toBe(true);
  });

  it("resolves a write target that does not exist yet via its nearest ancestor", async () => {
    // Symlinked parent + not-yet-created nested tail (a fresh write).
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    const out = await canonicalizePath(dir, "link/new/deep/file.txt");
    expect(out).toBe(join(dir, "real", "new", "deep", "file.txt"));
  });

  it("canonicalizeRoots resolves, dedups, and keeps relative roots under cwd", async () => {
    await mkdir(join(dir, "sub"));
    const roots = await canonicalizeRoots([dir, "sub", dir], dir);
    expect(roots).toEqual([dir, join(dir, "sub")]);
  });
});
