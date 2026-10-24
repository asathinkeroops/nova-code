// Path canonicalization lives in @nova/base so both the CLI permission gate
// and the @nova/tools invariants ledger share one notion of "the real file".
// Re-exported here for the CLI's existing call sites; PATH_INPUT_TOOLS stays
// CLI-local because @nova/base must not know specific tool identifiers.
import { canonicalizePath } from "@nova/base";
import { aliasedPath } from "@nova/tools";
import { SHELL_TOOLS } from "./worktree-guard.js";

export { canonicalizePath, canonicalizeRoots } from "@nova/base";

/**
 * Tools whose `path` input is canonicalized (resolve + realpath) before a
 * permission decision, so the decision is made on the real target rather than
 * the raw string. read/write/edit touch the file; glob/grep use `path` as the
 * search root and must be fenced to the workspace the same way (otherwise the
 * model could enumerate or grep arbitrary out-of-tree files and exfiltrate the
 * results). NOTE: this is a superset of the @nova/tools invariants set
 * (read/write/edit) — glob/grep are gated here but not tracked for
 * read-before-edit.
 */
export const PATH_INPUT_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
]);

/**
 * Tools whose schema accepts a `filePath`/`file_path`/`file` alias for `path`
 * (the `withAliases` wrapper in @nova/tools). Only these need alias resolution
 * at the gate: glob/grep use a bare `z.object({ path })`, so a stray alias on
 * those is ignored by the tool and must be ignored by the gate too — otherwise
 * the gate would judge a different directory than the call searches.
 */
const PATH_ALIAS_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/**
 * Canonicalize a raw tool input's path for the permission gate.
 *
 * The gate runs BEFORE the dispatcher validates the input, so it must resolve
 * the path exactly the way the tool schema will: `path` first, then — for the
 * tools that accept them — the `filePath`/`file_path`/`file` aliases. Reading
 * `input.path` directly treated an alias-only call as "no path" and fell back
 * to `"."` — i.e. the workspace root — so a write/read addressed via
 * `filePath` was judged as an in-workspace operation and auto-granted, then
 * executed against the real out-of-workspace target. Hence `aliasedPath` here,
 * not `input.path`.
 *
 * Shell tools (`bash`, `monitor`) get their optional `cwd` canonicalized the
 * same way, against the session workspace: the isolation gate and the spawned
 * process must agree on where a command runs, and a symlink inside the worktree
 * must not resolve execution back into the main checkout after the gate has
 * judged the lexical path.
 *
 * Returns a shallow copy with `path` / `cwd` replaced by the canonical form;
 * the alias keys are preserved. Tools outside both sets are returned untouched.
 * An absent/empty path falls back to `"."` (glob/grep's documented "search the
 * cwd" default); for read/write/edit the schema rejects the call afterwards,
 * so the fallback cannot grant anything the tool would accept.
 */
export async function canonicalizeGateInput(
  tool: string,
  input: Record<string, unknown>,
  workspace: string,
): Promise<Record<string, unknown>> {
  const rawCwd = input.cwd;
  const cwd =
    SHELL_TOOLS.has(tool) && typeof rawCwd === "string" && rawCwd.length > 0
      ? { cwd: await canonicalizePath(workspace, rawCwd) }
      : {};

  if (!PATH_INPUT_TOOLS.has(tool)) {
    return Object.keys(cwd).length > 0 ? { ...input, ...cwd } : input;
  }
  const raw = PATH_ALIAS_TOOLS.has(tool) ? aliasedPath(input) : input.path;
  const target = typeof raw === "string" && raw.length > 0 ? raw : ".";
  return { ...input, ...cwd, path: await canonicalizePath(workspace, target) };
}
