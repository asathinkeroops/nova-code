import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizePath, canonicalizePathSync, canonicalizeRoots } from "./path-safety.js";

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

  it("canonicalizePathSync matches the async twin, symlink and missing tail included", async () => {
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    for (const p of ["link/file.ts", "link/new/deep/file.txt", "src/../../escape.txt", "missing"]) {
      expect(canonicalizePathSync(dir, p)).toBe(await canonicalizePath(dir, p));
    }
    // Same fallback for a path whose whole chain is missing: lexical, `..`-folded.
    expect(canonicalizePathSync("/no/such/root", "a/../b")).toBe("/no/such/root/b");
  });

  // `..` is applied to the RESOLVED target of the preceding component, exactly
  // as the kernel does it — `link/..` is the parent of what link points at, not
  // the directory holding the link. Both the lexical pre-fold (resolve) and
  // Node's non-native realpath got this wrong, which let `git -C link/..`
  // reach the main checkout past the worktree guard.
  it("resolves `..` after a symlink the way the kernel does", async () => {
    await mkdir(join(dir, "target", "inner"), { recursive: true });
    await symlink(join(dir, "target", "inner"), join(dir, "link"));

    // NB: build the string by hand — `path.join(dir, "link/..")` would
    // normalize the `..` away before the kernel ever sees it, which is exactly
    // the bug this test is about.
    const kernel = realpathSync.native(`${dir}/link/..`);
    expect(kernel).toBe(join(dir, "target"));
    expect(canonicalizePathSync(dir, "link/..")).toBe(kernel);
    expect(await canonicalizePath(dir, "link/..")).toBe(kernel);

    // A deeper tail keeps applying to the resolved directory.
    expect(canonicalizePathSync(dir, "link/../inner")).toBe(join(dir, "target", "inner"));
  });

  it("follows a chain of symlinks before applying `..`", async () => {
    await mkdir(join(dir, "target", "inner"), { recursive: true });
    await symlink(join(dir, "target", "inner"), join(dir, "link"));
    await symlink(join(dir, "link"), join(dir, "link2")); // link2 -> link -> target/inner

    expect(canonicalizePathSync(dir, "link2/..")).toBe(join(dir, "target"));
    expect(canonicalizePathSync(dir, "link2/../..")).toBe(dir);
    expect(await canonicalizePath(dir, "link2/../..")).toBe(dir);
  });

  it("keeps an in-tree symlink's `..` inside the tree", async () => {
    await mkdir(join(dir, "real", "sub"), { recursive: true });
    await symlink(join(dir, "real"), join(dir, "link"));

    expect(canonicalizePathSync(dir, "link/sub/..")).toBe(join(dir, "real"));
    // Missing tail after the link still starts from the resolved target.
    expect(canonicalizePathSync(dir, "link/new/deep/file.txt")).toBe(
      join(dir, "real", "new", "deep", "file.txt"),
    );
  });

  // A final DANGLING link is not a missing path: the OS follows it and creates
  // its target. Reporting the link would let the gate approve one file while the
  // write creates another.
  it("follows a final dangling symlink to the file the OS would create", async () => {
    await mkdir(join(dir, "target"));
    await symlink(join(dir, "target", "new.txt"), join(dir, "dangling.txt"));
    const expected = join(dir, "target", "new.txt");

    expect(canonicalizePathSync(dir, "dangling.txt")).toBe(expected);
    expect(await canonicalizePath(dir, "dangling.txt")).toBe(expected);

    // Relative link targets resolve against the link's directory, and a chain
    // of dangling links is followed too.
    await symlink("dangling.txt", join(dir, "dangling2.txt"));
    expect(canonicalizePathSync(dir, "dangling2.txt")).toBe(expected);
    expect(await canonicalizePath(dir, "dangling2.txt")).toBe(expected);
  });

  it("leaves a plain missing path alone", async () => {
    // No link involved: the nearest-ancestor fallback is still the answer.
    expect(canonicalizePathSync(dir, "not/created/yet.txt")).toBe(
      join(dir, "not", "created", "yet.txt"),
    );
  });
});
