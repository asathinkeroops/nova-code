import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import ignore from "ignore";

/**
 * Builds the workspace file snapshot that powers `@path` mention completion in
 * the InputBox. Pure I/O — no UI. Mirrors the glob tool's .gitignore handling
 * (`packages/tools/src/glob.ts`) so completion sees the same files the
 * agent's `glob`/`grep` tools do.
 */

const ALWAYS_IGNORE = ["**/node_modules/**", "**/.git/**"];

/** Cap on the snapshot size — a runaway-repo backstop, not a real limit. */
export const DEFAULT_FILE_INDEX_LIMIT = 10_000;

async function findRepoRoot(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    try {
      const s = await stat(resolve(dir, ".git"));
      if (s.isDirectory() || s.isFile()) return dir;
    } catch {
      // not here, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readGitignoresUpTo(searchRoot: string, repoRoot: string) {
  const filter = ignore();
  const dirs: string[] = [];
  let dir = searchRoot;
  for (;;) {
    dirs.push(dir);
    if (dir === repoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Apply outermost first so nested .gitignore can override (ignore lib processes in order).
  for (const d of dirs.reverse()) {
    try {
      const text = await readFile(resolve(d, ".gitignore"), "utf8");
      filter.add(text);
    } catch {
      // missing .gitignore — fine
    }
  }
  return filter;
}

/**
 * List workspace files relative to `root` (posix-style, sorted), honoring
 * .gitignore and always skipping `node_modules` / `.git`. Returns at most
 * `limit` entries. Never throws — a glob failure yields an empty list so the
 * caller can fall back to no completion.
 */
export async function listWorkspaceFiles(
  root: string,
  limit: number = DEFAULT_FILE_INDEX_LIMIT,
): Promise<string[]> {
  let matches: string[];
  try {
    matches = await fg("**/*", {
      cwd: root,
      dot: false,
      followSymbolicLinks: false,
      onlyFiles: true,
      ignore: ALWAYS_IGNORE,
      suppressErrors: true,
    });
  } catch {
    return [];
  }

  const repoRoot = await findRepoRoot(root);
  const base = repoRoot ?? root;
  const filter = await readGitignoresUpTo(root, base);
  const kept = matches.filter((rel) => {
    const abs = resolve(root, rel);
    const fromRoot = relative(base, abs).split(sep).join("/");
    if (!fromRoot || fromRoot.startsWith("..")) return true;
    return !filter.ignores(fromRoot);
  });

  kept.sort();
  return kept.slice(0, limit);
}
