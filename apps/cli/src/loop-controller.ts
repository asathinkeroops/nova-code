/**
 * Backing state + timer for the `/loop` command. Pure and `ctx`-free: it only
 * flips a `due` flag and wakes a parked REPL; the REPL runs each iteration
 * inline (see `runLoopIteration` in repl.ts) and calls `rearm()` once the turn
 * completes. Scheduling is therefore **completion-relative** — the next tick is
 * armed one interval *after* the previous iteration finishes, never on a free
 * wall clock. Two iterations can never overlap, and nothing piles up: at most
 * one `due` is ever pending, and the timer is armed exactly once per completed
 * iteration. The loop stops after `maxIterations` iterations.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const UNITS = { s: SECOND, m: MINUTE, h: HOUR } as const;

/**
 * Parse a human interval like `30s`, `5m`, `1h` into milliseconds. Returns null
 * for anything that isn't a positive integer followed by a single s/m/h unit —
 * callers surface a usage error. A bare number (no unit) is rejected on purpose
 * so `/loop 5 ...` can't silently mean 5ms.
 */
export function parseDuration(input: string): number | null {
  const m = /^(\d+)(s|m|h)$/.exec(input.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * UNITS[m[2] as keyof typeof UNITS];
}

/** Render a millisecond interval back to the compact `Ns`/`Nm`/`Nh` form for cards. */
export function formatDuration(ms: number): string {
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`;
  return `${Math.round(ms / SECOND)}s`;
}

export class LoopController {
  readonly payload: string;
  readonly intervalMs: number;
  readonly maxIterations: number;
  private iterations = 0;
  private due = false;
  private active = true;
  private timer: NodeJS.Timeout | null = null;
  private readonly wake: () => void;

  constructor(opts: {
    payload: string;
    intervalMs: number;
    maxIterations: number;
    wake: () => void;
  }) {
    this.payload = opts.payload;
    this.intervalMs = opts.intervalMs;
    this.maxIterations = opts.maxIterations;
    this.wake = opts.wake;
  }

  /** True when an iteration is waiting to run at the next REPL idle point. */
  isDue(): boolean {
    return this.active && this.due;
  }

  /** True until stopped or the cap is reached. */
  isActive(): boolean {
    return this.active;
  }

  /** Iterations run so far. */
  count(): number {
    return this.iterations;
  }

  /**
   * Mark the first iteration ready to run immediately. No timer/wake needed: the
   * `/loop` command returns straight to the REPL top, which sees `isDue()`.
   */
  armFirst(): void {
    if (this.active) this.due = true;
  }

  /**
   * Consume the pending `due` and count this iteration. Returns true when the
   * safety cap is reached (the caller then stops the loop instead of re-arming).
   */
  noteIteration(): boolean {
    this.due = false;
    this.iterations += 1;
    return this.iterations >= this.maxIterations;
  }

  /**
   * Schedule the next iteration one interval out — called by the REPL *after*
   * the current iteration's turn completes, so cadence is completion-relative
   * and iterations can't overlap. On fire it flips `due` and wakes a parked
   * REPL. `.unref()` so a pending tick never keeps the Node process alive.
   */
  rearm(): void {
    if (!this.active) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.active) return;
      this.due = true;
      this.wake();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Cancel the loop: no more ticks, `isDue()` goes false. Idempotent. */
  stop(): void {
    this.active = false;
    this.due = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
