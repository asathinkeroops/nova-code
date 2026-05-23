import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";

const inputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Glob pattern (fast-glob syntax). Examples: '**/*.ts', 'src/**/*.{ts,tsx}', 'packages/*/package.json'.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Optional base directory for the search (absolute, or relative to cwd). Defaults to the session cwd.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(1000)
    .describe("Cap on the number of returned paths (default 1000)."),
  respect_gitignore: z
    .boolean()
    .default(true)
    .describe(
      "Honor .gitignore files between the search root and the repo root (default true). Set false to include ignored files.",
    ),
});

const ALWAYS_IGNORE = ["**/node_modules/**", "**/.git/**"];

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

export const globTool: ToolHandler = {
  definition: {
    name: "glob",
    description:
      "Find files matching a glob pattern. Use this to enumerate files by name/extension before reading them. Use grep instead when searching file contents. Honors .gitignore by default and always skips node_modules and .git.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    const base = input.path
      ? isAbsolute(input.path)
        ? input.path
        : resolve(ctx.cwd, input.path)
      : ctx.cwd;

    let matches: string[];
    try {
      matches = await fg(input.pattern, {
        cwd: base,
        dot: false,
        followSymbolicLinks: false,
        onlyFiles: true,
        ignore: ALWAYS_IGNORE,
        suppressErrors: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `glob failed: ${msg}`, isError: true };
    }

    if (input.respect_gitignore) {
      const repoRoot = await findRepoRoot(base);
      const root = repoRoot ?? base;
      const filter = await readGitignoresUpTo(base, root);
      matches = matches.filter((rel) => {
        const absPath = resolve(base, rel);
        const fromRoot = relative(root, absPath).split(sep).join("/");
        if (!fromRoot || fromRoot.startsWith("..")) return true;
        return !filter.ignores(fromRoot);
      });
    }

    matches.sort();
    const truncated = matches.length > input.limit;
    const out = matches.slice(0, input.limit);
    if (out.length === 0) {
      return { output: `(no matches for ${input.pattern} under ${base})` };
    }
    const header = `${out.length}${truncated ? `/${matches.length} (truncated)` : ""} match${out.length === 1 ? "" : "es"} under ${base}`;
    return { output: `${header}\n${out.join("\n")}` };
  },
};
