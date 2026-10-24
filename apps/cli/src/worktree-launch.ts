import { loadSettings, parseSettings } from "@nova/base";
import { addWorktree, currentBranch, repoRoot, type AddWorktreeOptions } from "./worktree.js";

/**
 * `--worktree` planning, kept out of `index.ts` so the flag rules are testable
 * without executing the CLI's commander wiring.
 */

export interface WorktreeLaunchFlags {
  worktree?: string | boolean;
  worktreeFrom?: string;
  resume?: string;
  /** Accepted on purpose — see {@link worktreeFlagConflict}. */
  continue?: boolean;
  cwd?: string;
}

/**
 * Flag combinations that cannot both take effect. Pure, so it runs (and is
 * tested) before any filesystem work.
 *
 * `--resume <id>` already decides the checkout: the session re-enters the
 * worktree it was bound to (see `resolveSession`). Pairing it with `--worktree`
 * used to create a checkout and then ignore it — an orphan directory plus a
 * confusing "why is nothing here" moment. Fail instead, before anything is
 * written.
 *
 * `--continue` is NOT a conflict: it means "the most recent session in this
 * workspace", and the workspace here is the worktree we are about to open, so
 * the two compose naturally.
 */
export function worktreeFlagConflict(flags: WorktreeLaunchFlags): string | undefined {
  if (flags.worktree === undefined || !flags.resume) return undefined;
  return (
    "--worktree cannot be combined with --resume: a resumed session stays in the checkout it was bound to, " +
    "so the new worktree would be created and then ignored. Run `nova --resume <id>` in that checkout, " +
    "or drop --resume to start a fresh session in the worktree."
  );
}

/**
 * Work out WHAT `--worktree` would create, without creating it.
 *
 * Creation writes into the repository (`git worktree add` touches the shared
 * object store and drops a checkout), so it must not happen before the user has
 * trusted that repository — which needs the mounted screen. Planning is read-only
 * and lets a bad name / non-repo / conflicting flag fail fast, before any UI work.
 * Only the `worktree` settings block is read here; a config that fails validation
 * later still cannot leave a half-created checkout behind (a parse failure falls
 * back to the schema defaults, and `addWorktree` is idempotent by name).
 */
export async function planWorktreeLaunch(flags: WorktreeLaunchFlags): Promise<AddWorktreeOptions> {
  const conflict = worktreeFlagConflict(flags);
  if (conflict) throw new Error(conflict);

  const launchDir = flags.cwd ?? process.cwd();
  const settings = await loadSettings().catch(() => parseSettings({}));
  if (!settings.worktree.enabled) {
    throw new Error("--worktree is disabled (settings.worktree.enabled = false)");
  }
  const repo = await repoRoot(launchDir);
  if (!repo) throw new Error(`--worktree: ${launchDir} is not a git repository`);

  const requested =
    typeof flags.worktree === "string" && flags.worktree.trim().length > 0
      ? flags.worktree.trim()
      : ((await currentBranch(repo)) ?? "worktree");
  return {
    repo,
    name: requested,
    dir: settings.worktree.dir,
    baseRef: settings.worktree.baseRef,
    includeFile: settings.worktree.includeFile,
    ...(flags.worktreeFrom ? { from: flags.worktreeFrom } : {}),
  };
}

/** Create (or re-open) the planned checkout. Call only after trust is granted. */
export async function materializeWorktree(plan: AddWorktreeOptions): Promise<string> {
  return (await addWorktree(plan)).path;
}
