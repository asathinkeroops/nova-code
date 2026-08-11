import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * All-time (cross-session) token ledger backing the StatusLine's `累计 / total`
 * cache hit rate, stored as a single small JSON file under `~/.nova`.
 *
 * Why a ledger rather than replaying transcripts: the per-session counters are
 * rebuilt by summing that session's `transcript.jsonl` (see `usage-restore.ts`),
 * which cannot answer "all time" — it would mean scanning every directory under
 * `~/.nova/sessions` on every launch (cost grows with session count), and the
 * answer would still be wrong, since `sessionCleanup.maxAgeDays` deletes session
 * dirs after 30 days. A running total, written as it happens, is O(1) at boot
 * and keeps counting after the transcripts it came from are gone.
 *
 * Loss of this file is harmless (the counter restarts), so every operation here
 * is best-effort and never throws into the caller.
 */

/** Absolute totals held in the ledger file. */
export interface LifetimeUsage {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
}

/** One request's usage, as reported by `post_request`. */
export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** `~/.nova/usage.json` — the cross-session token ledger. */
export function globalUsagePath(): string {
  return join(homedir(), ".nova", "usage.json");
}

/** All-zero totals — the value a missing or unreadable ledger reads as. */
export function emptyLifetimeUsage(): LifetimeUsage {
  return {
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
}

/** Coerce one field of a parsed ledger: non-finite / negative / absent → 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Read the ledger. A missing, malformed, or partially-written file yields
 * all-zero totals rather than throwing — an all-time counter is a statistic,
 * never load-bearing.
 */
export async function loadGlobalUsage(path: string = globalUsagePath()): Promise<LifetimeUsage> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyLifetimeUsage();
    const rec = parsed as Record<string, unknown>;
    return {
      cacheReadTokens: num(rec.cacheReadTokens),
      cacheCreationTokens: num(rec.cacheCreationTokens),
      uncachedInputTokens: num(rec.uncachedInputTokens),
      outputTokens: num(rec.outputTokens),
    };
  } catch {
    return emptyLifetimeUsage();
  }
}

/** Sum of two ledgers, field by field. */
function add(base: LifetimeUsage, delta: LifetimeUsage): LifetimeUsage {
  return {
    cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
    cacheCreationTokens: base.cacheCreationTokens + delta.cacheCreationTokens,
    uncachedInputTokens: base.uncachedInputTokens + delta.uncachedInputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
  };
}

/**
 * Accumulates per-request usage in memory and folds it into the on-disk ledger
 * on a timer.
 *
 * Batched rather than written per request because a turn with a tool loop fires
 * many requests, and each flush is a read-modify-write plus an atomic rename.
 *
 * Each flush **re-reads** the file and adds the pending delta to what it finds,
 * instead of writing a total this process computed at boot. That's what keeps
 * two nova windows running side by side from clobbering each other: whoever
 * writes last still adds their own spend to the other's. The merged total is
 * handed back through `onTotals` so the display converges on it too.
 */
export class GlobalUsageLedger {
  private pending = emptyLifetimeUsage();
  private timer: NodeJS.Timeout | null = null;
  /** Serializes flushes so two overlapping read-modify-writes can't drop one. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string = globalUsagePath(),
    private readonly onTotals?: (totals: LifetimeUsage) => void,
    private readonly delayMs: number = 5_000,
  ) {}

  /** Record one request; schedules a flush if none is pending. */
  add(usage: UsageDelta): void {
    this.pending = add(this.pending, {
      cacheReadTokens: usage.cacheReadInputTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
      uncachedInputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
    // Don't hold the process open for a statistics write.
    this.timer.unref?.();
  }

  /**
   * Fold everything recorded since the last flush into the file. Safe to call
   * with nothing pending (no-op) and safe to call concurrently (serialized).
   * Exposed for shutdown, so the tail of a session isn't lost.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const delta = this.pending;
    if (
      delta.cacheReadTokens === 0 &&
      delta.cacheCreationTokens === 0 &&
      delta.uncachedInputTokens === 0 &&
      delta.outputTokens === 0
    ) {
      return this.inFlight;
    }
    // Clear before the await so requests landing mid-write are counted by the
    // *next* flush rather than written twice.
    this.pending = emptyLifetimeUsage();
    this.inFlight = this.inFlight.then(async () => {
      const merged = add(await loadGlobalUsage(this.path), delta);
      try {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, `${JSON.stringify(merged)}\n`, "utf8");
        await rename(tmp, this.path);
        this.onTotals?.(merged);
      } catch {
        // Put the delta back so the next flush retries it rather than losing it.
        this.pending = add(this.pending, delta);
      }
    });
    return this.inFlight;
  }
}
