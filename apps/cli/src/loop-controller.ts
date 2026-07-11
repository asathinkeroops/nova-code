/**
 * Backing state + timer for the `/loop` command. Pure and `ctx`-free: on each
 * tick it just drops the payload into the input queue (via the injected
 * `enqueue` callback) and lets the REPL's normal machinery run it — a parked
 * `takeInput` gets it immediately, otherwise it queues for the next turn, the
 * same path a typed line takes. The controller never drives the agent itself.
 *
 * The cadence is steady wall-clock (setInterval-like): the next tick is armed
 * one interval after each fire, independent of how long a turn runs. A total of
 * `maxIterations` payloads are enqueued, then the loop stops and calls `onCap`.
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
  /** Called after the loop stops itself on reaching the iteration cap. */
  onCap: () => void = () => {};
  private iterations = 0;
  private active = true;
  private timer: NodeJS.Timeout | null = null;
  private readonly enqueue: (line: string) => void;

  constructor(opts: {
    payload: string;
    intervalMs: number;
    maxIterations: number;
    enqueue: (line: string) => void;
  }) {
    this.payload = opts.payload;
    this.intervalMs = opts.intervalMs;
    this.maxIterations = opts.maxIterations;
    this.enqueue = opts.enqueue;
  }

  /** Payloads enqueued so far. */
  count(): number {
    return this.iterations;
  }

  /** True until stopped or the cap is reached. */
  isActive(): boolean {
    return this.active;
  }

  /** Enqueue the first payload immediately, then keep ticking every interval. */
  start(): void {
    if (this.active) this.fire();
  }

  /** Enqueue one payload and arm the next tick. */
  private fire(): void {
    this.iterations += 1;
    this.enqueue(this.payload);
    if (this.iterations >= this.maxIterations) {
      this.stop();
      this.onCap();
      return;
    }
    // `.unref()` so a pending tick never keeps the Node process alive on exit.
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.active) this.fire();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Cancel the loop: no more ticks. Idempotent. */
  stop(): void {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
