import type { CronEntry, CronStore } from "@nova/tools";

/**
 * Timing engine for scheduled entries — the analog of the old `LoopController`,
 * generalized to N concurrent entries. It owns the timers and wakes the REPL; the
 * REPL runs due payloads inline (see `runDueCron` in repl.ts). It lives in the CLI
 * (not `@nova/tools`) because it needs `screen.wake()`.
 *
 * The `CronStore` is the source of truth: the scheduler subscribes to `onChange`
 * and reconciles timers to match. Reconciliation is idempotent — for every active
 * entry with a `nextRunAt` (and not currently due or running) it keeps exactly one
 * timer armed for that instant; when the entry's `nextRunAt` moves, the stale
 * timer is replaced. `.unref()` so a pending tick never keeps Node alive.
 */
export interface CronSchedulerOptions {
  store: CronStore;
  /** Unpark the REPL so it can run a due entry. */
  wake: () => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class CronScheduler {
  private readonly store: CronStore;
  private readonly wake: () => void;
  private readonly now: () => number;
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; at: number }>();
  /** Entries whose timer has fired and are waiting for the REPL to run them. */
  private readonly due = new Set<string>();
  /** Entries the REPL is running right now — never re-armed until the run ends. */
  private readonly running = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(opts: CronSchedulerOptions) {
    this.store = opts.store;
    this.wake = opts.wake;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Load persisted entries and arm them. On resume, interval entries are re-armed
   * one interval out from *now* (not their stale on-disk `nextRunAt`) so a resumed
   * session doesn't fire a surprise burst; cron entries re-arm at their next
   * matching minute. `reschedule` runs before we subscribe, so it doesn't trigger
   * a redundant reconcile per entry.
   */
  async init(): Promise<void> {
    await this.store.ensureLoaded();
    const now = this.now();
    for (const e of this.store.snapshot()) {
      if (e.status === "active") await this.store.reschedule(e.id, now);
    }
    this.unsubscribe = this.store.onChange((entries) => this.reconcile(entries));
    this.reconcile(this.store.snapshot());
  }

  /** Active entries whose timer has fired — the REPL polls this between turns. */
  dueEntries(): CronEntry[] {
    return this.store.snapshot().filter((e) => this.due.has(e.id) && e.status === "active");
  }

  /** Mark an entry as running: consume its due flag and pin it against re-arming. */
  beginRun(id: string): void {
    this.due.delete(id);
    this.running.add(id);
  }

  /** Finish a run: unpin and reconcile so the (rescheduled) entry re-arms. */
  endRun(id: string): void {
    this.running.delete(id);
    this.reconcile(this.store.snapshot());
  }

  /** Tear down all timers and stop listening. Idempotent. */
  dispose(): void {
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.due.clear();
    this.running.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private reconcile(entries: CronEntry[]): void {
    const wanted = new Map<string, number>();
    for (const e of entries) {
      if (
        e.status === "active" &&
        e.nextRunAt !== null &&
        !this.running.has(e.id) &&
        !this.due.has(e.id)
      ) {
        wanted.set(e.id, e.nextRunAt);
      }
    }
    // Drop timers that are no longer wanted or whose fire-time moved.
    for (const [id, rec] of this.timers) {
      if (wanted.get(id) !== rec.at) {
        clearTimeout(rec.timer);
        this.timers.delete(id);
      }
    }
    // Arm a timer for every wanted entry that lacks one.
    for (const [id, at] of wanted) {
      if (this.timers.has(id)) continue;
      const delay = Math.max(0, at - this.now());
      const timer = setTimeout(() => {
        this.timers.delete(id);
        this.due.add(id);
        this.wake();
      }, delay);
      timer.unref?.();
      this.timers.set(id, { timer, at });
    }
  }
}
