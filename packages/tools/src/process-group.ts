/**
 * Process-group termination for the long-lived subprocess managers (background
 * commands and monitors).
 *
 * Both spawn through `/bin/bash -c`, so the direct child is a shell and the
 * processes that matter are usually its children: `pnpm dev` forks node,
 * `tail -f x | grep y` is two more processes. Signalling only the shell leaves
 * those alive — and because they inherited the stdout pipe, the stream never
 * ends, so the spawn promise never settles and session teardown hangs forever
 * while the orphans keep running.
 *
 * The fix is two halves that must be used together: spawn with
 * {@link DETACHED_SPAWN} so the child leads its own process group, and signal
 * with {@link killGroup}, which negates the pid to reach the whole group.
 */

/** Spread into an execa options object to make the child a group leader. */
export const DETACHED_SPAWN = { detached: true } as const;

/** Grace period between SIGTERM and SIGKILL for a group that ignores the first. */
export const SIGKILL_DELAY_MS = 1500;

/**
 * Upper bound on waiting for killed children to actually die. Session teardown
 * must never hang on a stubborn process, so callers give up after this.
 */
export const DISPOSE_WAIT_MS = 3000;

/**
 * Signal an entire process group (note the negated pid). Best-effort: a group
 * that has already exited raises ESRCH, which is the success case here.
 */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone, or never had a group — nothing left to clean up.
  }
}

/**
 * SIGTERM the group now, escalating to SIGKILL after {@link SIGKILL_DELAY_MS}.
 * Returns a canceller for the escalation timer, to be called once the child's
 * lifecycle settles so a finished process leaves no pending timer behind.
 */
export function terminateGroup(pid: number | undefined): () => void {
  killGroup(pid, "SIGTERM");
  const timer = setTimeout(() => killGroup(pid, "SIGKILL"), SIGKILL_DELAY_MS);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Await `waits`, but never longer than {@link DISPOSE_WAIT_MS}. Anything still
 * alive past that has ignored both SIGTERM and SIGKILL to its whole group, and
 * blocking session exit on it helps nobody.
 */
export async function awaitBounded(waits: Array<Promise<unknown>>): Promise<void> {
  if (waits.length === 0) return;
  await Promise.race([
    Promise.allSettled(waits),
    new Promise((resolve) => setTimeout(resolve, DISPOSE_WAIT_MS).unref?.()),
  ]);
}
