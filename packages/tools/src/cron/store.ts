import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { cronEntrySchema, type CronEntry, type ScheduleSpec } from "./schema.js";
import { nextCronFire, parseCron } from "./parse.js";

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export interface CronLimits {
  /** Reject interval schedules shorter than this. */
  minIntervalMs: number;
  /** Default per-entry iteration cap. */
  maxIterations: number;
  /** Cap on concurrent active `source:"tool"` entries. */
  maxSchedules: number;
}

export const DEFAULT_CRON_LIMITS: CronLimits = {
  minIntervalMs: 1000,
  maxIterations: 100,
  maxSchedules: 20,
};

export interface CronCreateInput {
  schedule: ScheduleSpec;
  payload: string;
  source: "tool" | "loop";
  maxIterations: number;
  label?: string;
}

export interface CronListFilter {
  status?: "active" | "stopped";
  source?: "tool" | "loop";
}

type ChangeListener = (entries: CronEntry[]) => void;

function generateId(): string {
  return randomBytes(6).toString("base64url");
}

function clone(e: CronEntry): CronEntry {
  return { ...e, schedule: { ...e.schedule } };
}

/**
 * Compute the first fire for a freshly created entry. Interval entries fire
 * immediately (nextRunAt = now), reproducing `/loop`'s `armFirst`. Cron entries
 * fire at their next matching minute. Throws if a cron expression can never fire.
 */
function firstFire(schedule: ScheduleSpec, now: number): number {
  if (schedule.kind === "interval") return now;
  const fields = parseCron(schedule.expr);
  if (!fields) throw new CronError(`invalid cron expression: ${schedule.expr}`);
  const next = nextCronFire(fields, now);
  if (next === null) throw new CronError(`cron expression never fires: ${schedule.expr}`);
  return next;
}

/** Next fire after a completed run — completion-relative for intervals. */
function subsequentFire(schedule: ScheduleSpec, from: number): number | null {
  if (schedule.kind === "interval") return from + schedule.intervalMs;
  const fields = parseCron(schedule.expr);
  if (!fields) return null;
  return nextCronFire(fields, from);
}

/**
 * Per-session store of scheduled entries. Pure data + persistence — it never sets
 * a timer or dispatches; the `CronScheduler` (apps/cli) drives timing off
 * `onChange`. Persists one JSON per entry under `${sessionDir}/cron/`, atomically
 * (tmp + rename), and loads by scanning that dir (corrupt files skipped). Scoped
 * to the session dir so `/clear` (fresh dir) and `/resume` (point a new store at
 * the switched-in dir) need no extra bookkeeping.
 */
export class CronStore {
  private dir: string;
  private readonly entries = new Map<string, CronEntry>();
  private loadPromise: Promise<void> | null = null;
  private readonly listeners = new Set<ChangeListener>();
  readonly limits: CronLimits;

  constructor(sessionDir: string, limits: CronLimits = DEFAULT_CRON_LIMITS) {
    this.dir = path.join(sessionDir, "cron");
    this.limits = limits;
  }

  async create(input: CronCreateInput): Promise<CronEntry> {
    await this.ensureLoaded();
    if (input.source === "tool") {
      const active = Array.from(this.entries.values()).filter(
        (e) => e.source === "tool" && e.status === "active",
      ).length;
      if (active >= this.limits.maxSchedules) {
        throw new CronError(
          `too many schedules — the limit is ${this.limits.maxSchedules} (settings.cron.maxSchedules). ` +
            `Delete one with cronDelete first.`,
        );
      }
    }
    const now = Date.now();
    let id = generateId();
    while (this.entries.has(id)) id = generateId();
    const entry: CronEntry = {
      id,
      label: input.label ?? "",
      schedule: input.schedule,
      payload: input.payload,
      isCommand: input.payload.trimStart().startsWith("/"),
      source: input.source,
      status: "active",
      iterations: 0,
      maxIterations: input.maxIterations,
      createdAt: now,
      nextRunAt: firstFire(input.schedule, now),
      lastRunAt: null,
    };
    this.entries.set(id, entry);
    await this.persist(entry);
    this.emit();
    return clone(entry);
  }

  async list(filter?: CronListFilter): Promise<CronEntry[]> {
    await this.ensureLoaded();
    let all = Array.from(this.entries.values(), clone);
    if (filter?.status) all = all.filter((e) => e.status === filter.status);
    if (filter?.source) all = all.filter((e) => e.source === filter.source);
    return all;
  }

  async get(id: string): Promise<CronEntry | undefined> {
    await this.ensureLoaded();
    const e = this.entries.get(id);
    return e ? clone(e) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.entries.delete(id);
    if (existed) {
      await this.unlink(id);
      this.emit();
    }
    return existed;
  }

  /**
   * Count this run and check the cap. Called *before* dispatch so the iteration
   * number is correct and a re-entrant delete in the payload is respected. When
   * the cap is reached the entry flips to `stopped` (nextRunAt cleared).
   */
  async noteRun(id: string, firedAt: number): Promise<{ entry: CronEntry; capped: boolean } | undefined> {
    await this.ensureLoaded();
    const e = this.entries.get(id);
    if (!e) return undefined;
    e.iterations += 1;
    e.lastRunAt = firedAt;
    const capped = e.iterations >= e.maxIterations;
    if (capped) {
      e.status = "stopped";
      e.nextRunAt = null;
    }
    await this.persist(e);
    this.emit();
    return { entry: clone(e), capped };
  }

  /**
   * Recompute the next fire *after* a run completes — completion-relative for
   * intervals, next matching minute for cron. No-op for stopped/missing entries.
   */
  async reschedule(id: string, from: number): Promise<CronEntry | undefined> {
    await this.ensureLoaded();
    const e = this.entries.get(id);
    if (!e || e.status !== "active") return undefined;
    e.nextRunAt = subsequentFire(e.schedule, from);
    if (e.nextRunAt === null) e.status = "stopped"; // cron that can no longer fire
    await this.persist(e);
    this.emit();
    return clone(e);
  }

  async stop(id: string): Promise<void> {
    await this.ensureLoaded();
    const e = this.entries.get(id);
    if (!e || e.status === "stopped") return;
    e.status = "stopped";
    e.nextRunAt = null;
    await this.persist(e);
    this.emit();
  }

  async clearAll(): Promise<void> {
    await this.ensureLoaded();
    this.entries.clear();
    try {
      await fs.rm(this.dir, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.emit();
  }

  /**
   * Re-point this store at a different session's dir and drop the in-memory
   * cache, so the next `ensureLoaded` reloads from the new location. Used on
   * `/resume` / `/clear`: the tool closures hold this instance, so we mutate it
   * rather than swap it. Dispose the scheduler before calling and re-init after.
   */
  retarget(sessionDir: string): void {
    this.dir = path.join(sessionDir, "cron");
    this.entries.clear();
    this.loadPromise = null;
  }

  /** Current in-memory entries (sync). Valid after `ensureLoaded`/`load`. */
  snapshot(): CronEntry[] {
    return Array.from(this.entries.values(), clone);
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Load persisted entries. Idempotent; callers may await before reconciling. */
  async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  private async load(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(path.join(this.dir, name), "utf8");
        const parsed = cronEntrySchema.safeParse(JSON.parse(content));
        if (parsed.success) this.entries.set(parsed.data.id, parsed.data);
      } catch {
        // skip corrupted file
      }
    }
  }

  private async persist(entry: CronEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, `${entry.id}.json`);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
  }

  private async unlink(id: string): Promise<void> {
    try {
      await fs.unlink(path.join(this.dir, `${id}.json`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
