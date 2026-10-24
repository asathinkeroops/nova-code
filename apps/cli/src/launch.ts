import { resolveSession, type ResolvedSession, type ResolveSessionOptions } from "./session.js";

/**
 * Decide WHICH CHECKOUT a run uses, and do it in the only order that keeps the
 * trust boundary honest.
 *
 * Both of nova's entry points used to check trust on the launch directory and
 * only then let `resolveSession` move the session into a linked worktree — so a
 * `--resume` could end up loading `CLAUDE.md`, project hooks (shell commands!)
 * and plugins from a directory nobody had approved. Creating `--worktree` had
 * the mirror-image problem: `git worktree add` ran before the trust gate, i.e.
 * nova wrote into a repository the user had not consented to yet.
 *
 * The order enforced here:
 *
 *   1. trust the LAUNCH directory — we may be about to write into that repo;
 *   2. materialize the `--worktree` checkout (only now);
 *   3. resolve the session, which may re-enter a worktree the session was bound
 *      to (see `resolveSession`);
 *   4. trust the FINAL workspace — its project configuration is what gets
 *      loaded next, so that is the path the decision has to cover.
 *
 * `requireTrust` is injected because the two hosts react differently: the TUI
 * shows the confirmation dialog, headless dies with an explanation (and
 * `--dangerously-skip-permissions` makes both a no-op). Repeated calls for an
 * already-trusted directory are cheap — the host's check short-circuits.
 */
export interface LaunchTargetOptions {
  /** Where nova was launched, after `--cwd` / a previous `--worktree` rewrite. */
  launchDir: string;
  sessionDir?: string;
  resume?: string;
  continue?: boolean;
  /** Verify (or interactively obtain) trust for a directory; throws when denied. */
  requireTrust: (dir: string) => Promise<void>;
  /** Create (or re-open) the `--worktree` checkout and return its path. */
  materializeWorktree?: (() => Promise<string>) | undefined;
}

export async function resolveLaunchTarget(opts: LaunchTargetOptions): Promise<ResolvedSession> {
  await opts.requireTrust(opts.launchDir);

  const workspace = opts.materializeWorktree ? await opts.materializeWorktree() : opts.launchDir;

  const sessionOpts: ResolveSessionOptions = {
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...(opts.continue ? { continue: true } : {}),
  };
  const target = await resolveSession(sessionOpts, opts.sessionDir, workspace);

  await opts.requireTrust(target.workspace);
  return target;
}
