import { lstatSync, readlinkSync, realpath, realpathSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/**
 * Resolve a filesystem path to an absolute, symlink-resolved form so callers
 * reason about the bytes that will actually be touched — not the raw string a
 * model supplied.
 *
 * The traversal has to match what the OS does with the path, because that is
 * what the tool will do: components are resolved LEFT TO RIGHT, a symlink is
 * followed when it is crossed, and a `..` then applies to the RESOLVED target.
 * `link/..` is therefore the parent of what `link` points at, not the directory
 * containing the link:
 *
 *   /repo/worktrees/feat/main-link -> /repo/main-sub
 *   "main-link/.."  ==  /repo        (not /repo/worktrees/feat)
 *
 * Two consequences:
 *
 *  - Never pre-normalize with `path.resolve()`: it folds `..` lexically and
 *    destroys that distinction before the OS ever sees it.
 *  - Use the NATIVE realpath (`realpathSync.native` / `realpath.native`). Node's
 *    JavaScript implementation normalizes `..` lexically on its way through the
 *    components, which reproduces the same bug.
 *
 * For a path that does not exist yet (a write target), the nearest existing
 * ancestor is realpath'd and the missing tail re-appended. A `..` in that
 * missing tail can only be folded lexically — the OS would fail the lookup
 * entirely — which is the best available answer.
 *
 * A final component that is a DANGLING symlink is not a missing path: the OS
 * follows the link and creates its target, so `write dangling-link` writes the
 * target while a nearest-ancestor fallback would report the link. One level of
 * `lstat` + `readlink` (bounded) closes that gap, keeping "the file the checks
 * name" and "the file the tool touches" the same file.
 *
 * Shared by the CLI permission gate (decide allow/ask on the real target), the
 * tools invariants ledger (key read-before-edit/mtime state), the execution key,
 * the snapshot store and the file tools' own I/O — all of them must agree on
 * what "this file" means.
 *
 * Best-effort: on any non-ENOENT error (EACCES, ELOOP, …) it falls back to the
 * logical absolute path (normalized, but not symlink-resolved).
 */
export async function canonicalizePath(cwd: string, rawPath: string): Promise<string> {
  return realpathNearest(absolutePath(cwd, rawPath));
}

/**
 * Canonicalize a set of root directories once (e.g. at startup). Relative roots
 * resolve against `cwd`; duplicates are collapsed while preserving order.
 */
export async function canonicalizeRoots(roots: readonly string[], cwd: string): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    out.push(await realpathNearest(absolutePath(cwd, root)));
  }
  return [...new Set(out)];
}

/**
 * Synchronous twin of {@link canonicalizePath}, for callers that cannot await —
 * the worktree isolation guard walks a shell command's text on every tool call,
 * so its `cd` / `git -C` / `GIT_*` targets must be compared as real paths
 * without turning the walk into an async state machine.
 */
export function canonicalizePathSync(cwd: string, rawPath: string): string {
  return realpathNearestSync(absolutePath(cwd, rawPath));
}

/**
 * Join without normalizing. `path.resolve` would fold `..` before the symlink
 * traversal that decides where `..` actually points; only the absolute-path
 * form is needed here, and the OS resolves the rest.
 */
function absolutePath(cwd: string, rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : `${cwd}/${rawPath}`;
}

/** Native (OS) realpath, promisified — see the module comment for why. */
function realpathNative(abs: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    realpath.native(abs, (err, real) => (err ? reject(err) : resolvePromise(plainPath(real))));
  });
}

/**
 * Strip the extended-length prefix Windows' native realpath may add
 * (`\\?\C:\…`). Everything else in Nova compares against plain `C:\…` paths,
 * so leaving the prefix on would make every containment test fail closed.
 */
function plainPath(real: string): string {
  if (process.platform !== "win32" || !real.startsWith("\\\\?\\")) return real;
  const rest = real.slice(4);
  return rest.startsWith("UNC\\") ? `\\\\${rest.slice(4)}` : rest;
}

/**
 * realpath() the deepest existing ancestor of `abs`, then re-append whatever
 * trailing segments do not exist yet. `abs` must already be absolute.
 *
 * `hops` bounds dangling-symlink unfurling (a → b → a cannot spin forever).
 * Only the ORIGINAL path's final component is unfurled: a dangling link in the
 * middle makes the OS operation fail, so there is no target to protect.
 */
async function realpathNearest(abs: string): Promise<string> {
  return realpathNearestFrom(abs, 0);
}

async function realpathNearestFrom(abs: string, hops: number): Promise<string> {
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = await realpathNative(current);
      // tail was collected deepest-first while walking up; reverse to shallow-first.
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return resolve(abs);
      if (tail.length === 0 && hops < MAX_LINK_HOPS) {
        const target = await danglingLinkTarget(current);
        // The OS follows the link and creates its target; reporting the link
        // would make the gate approve a file the write never touches.
        if (target !== undefined) return realpathNearestFrom(target, hops + 1);
      }
      const parent = dirname(current);
      if (parent === current) return resolve(abs); // at the root, nothing resolved
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** {@link realpathNearest}, synchronously and with the same fallback rules. */
function realpathNearestSync(abs: string): string {
  return realpathNearestSyncFrom(abs, 0);
}

function realpathNearestSyncFrom(abs: string, hops: number): string {
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = plainPath(realpathSync.native(current));
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return resolve(abs);
      if (tail.length === 0 && hops < MAX_LINK_HOPS) {
        const target = danglingLinkTargetSync(current);
        if (target !== undefined) return realpathNearestSyncFrom(target, hops + 1);
      }
      const parent = dirname(current);
      if (parent === current) return resolve(abs);
      tail.push(basename(current));
      current = parent;
    }
  }
}

const MAX_LINK_HOPS = 8;

/**
 * If `path` IS a symlink whose target does not exist, return that target
 * (absolute, uncollapsed). undefined when it is anything else — a regular
 * missing path, an existing target (realpath already succeeded), or something
 * we cannot inspect.
 */
async function danglingLinkTarget(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return undefined;
    const target = await readlink(path);
    return isAbsolute(target) ? target : `${dirname(path)}/${target}`;
  } catch {
    return undefined;
  }
}

function danglingLinkTargetSync(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    const target = readlinkSync(path);
    return isAbsolute(target) ? target : `${dirname(path)}/${target}`;
  } catch {
    return undefined;
  }
}
