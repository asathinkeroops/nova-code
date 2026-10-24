import { canonicalizePath } from "@nova/base";

/**
 * Resolve a tool's optional `cwd` input to the ABSOLUTE directory the command
 * will actually run in.
 *
 * Why this exists: `execa`/`spawn` resolve a relative `cwd` against the Node
 * process's working directory, while the session's workspace is a separate
 * value that moves (`/worktree`, `--cwd`). Nothing keeps the two in sync — nova
 * never calls `process.chdir` — so a relative `cwd` like `"."` used to execute
 * in the launch directory while the isolation gate judged it against the
 * workspace. Two different answers to "where does this run".
 *
 * Normalizing at the tool boundary makes the spawned process and the gate (and
 * the OS sandbox, which also gets this path) agree by construction; the gate
 * still resolves for itself as defense in depth.
 *
 * Canonicalization matches the permission gate's: `..` is folded and symlinks
 * are resolved (nearest existing ancestor for a path that does not exist yet),
 * so a symlink inside the workspace cannot point the command at another
 * checkout after the fact.
 */
export async function resolveToolCwd(
  inputCwd: string | undefined,
  sessionCwd: string,
): Promise<string> {
  return canonicalizePath(sessionCwd, inputCwd ?? ".");
}

/**
 * Resolve a file tool's `path` input to the exact file the tool will touch.
 *
 * Every consumer of that path must agree on the answer: the permission gate
 * (`canonicalizeGateInput`), the read-before-edit ledger, the dispatcher's
 * execution key and the snapshot lifecycle all canonicalize with
 * `canonicalizePath`. A tool that instead called `path.resolve(ctx.cwd, …)`
 * folded `..` LEXICALLY, before the symlink the OS would follow — so
 * `<link>/../victim.txt` was approved as (and recorded as) the workspace copy
 * and then written to a different file one directory up. Same string, two
 * targets. Routing the I/O through this helper makes execution and the checks
 * the same answer by construction, including for a final dangling symlink
 * (the OS follows it and creates its target).
 */
export async function resolveToolPath(sessionCwd: string, rawPath: string): Promise<string> {
  return canonicalizePath(sessionCwd, rawPath);
}
