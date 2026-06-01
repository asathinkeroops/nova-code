import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/**
 * Resolve a filesystem path to an absolute, symlink-resolved form so callers
 * reason about the bytes that will actually be touched — not the raw string a
 * model supplied. `..` segments are folded by `resolve()`; symlinks are
 * unwrapped by `realpath()`. For a path that does not exist yet (a write
 * target), the nearest existing ancestor is realpath'd and the missing tail
 * re-appended, so a symlinked parent directory still resolves correctly.
 *
 * Shared by the CLI permission gate (decide allow/ask on the real target) and
 * the tools invariants ledger (key read-before-edit/mtime state on the real
 * target) so the two agree on what "this file" means.
 *
 * Best-effort: on any non-ENOENT error (EACCES, ELOOP, …) it falls back to the
 * logical absolute path. That is still `..`-folded — it just isn't
 * symlink-resolved.
 */
export async function canonicalizePath(cwd: string, rawPath: string): Promise<string> {
  return realpathNearest(resolve(cwd, rawPath));
}

/**
 * Canonicalize a set of root directories once (e.g. at startup). Relative roots
 * resolve against `cwd`; duplicates are collapsed while preserving order.
 */
export async function canonicalizeRoots(roots: readonly string[], cwd: string): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    out.push(await realpathNearest(isAbsolute(root) ? root : resolve(cwd, root)));
  }
  return [...new Set(out)];
}

/**
 * realpath() the deepest existing ancestor of `abs`, then re-append whatever
 * trailing segments do not exist yet. `abs` must already be absolute.
 */
async function realpathNearest(abs: string): Promise<string> {
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = await realpath(current);
      // tail was collected deepest-first while walking up; reverse to shallow-first.
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return abs;
      const parent = dirname(current);
      if (parent === current) return abs; // reached the filesystem root, nothing resolved
      tail.push(basename(current));
      current = parent;
    }
  }
}
