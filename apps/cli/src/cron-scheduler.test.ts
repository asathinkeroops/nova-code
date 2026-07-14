import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStore } from "@nova/tools";
import { CronScheduler } from "./cron-scheduler.js";

let dir: string;

const interval = (intervalMs: number) => ({ kind: "interval" as const, intervalMs });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "nova-cron-sched-"));
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("CronScheduler", () => {
  it("arms an entry created after init and fires it immediately (first-fire-immediate)", async () => {
    const store = new CronStore(dir);
    const wake = vi.fn();
    const sched = new CronScheduler({ store, wake });
    await sched.init();

    const a = await store.create({ schedule: interval(5000), payload: "a", source: "loop", maxIterations: 100 });
    await vi.advanceTimersByTimeAsync(1);
    expect(sched.dueEntries().map((e) => e.id)).toEqual([a.id]);
    expect(wake).toHaveBeenCalled();
    sched.dispose();
  });

  it("re-arms one interval after completion (completion-relative)", async () => {
    const store = new CronStore(dir);
    const wake = vi.fn();
    const sched = new CronScheduler({ store, wake });
    await sched.init();
    const a = await store.create({ schedule: interval(5000), payload: "a", source: "loop", maxIterations: 100 });
    await vi.advanceTimersByTimeAsync(1);

    // Simulate the REPL running the due iteration.
    sched.beginRun(a.id);
    await store.noteRun(a.id, Date.now());
    await store.reschedule(a.id, Date.now());
    sched.endRun(a.id);
    expect(sched.dueEntries()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(4999);
    expect(sched.dueEntries()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sched.dueEntries().map((e) => e.id)).toEqual([a.id]);
    sched.dispose();
  });

  it("drops a timer when its entry is deleted", async () => {
    const store = new CronStore(dir);
    const sched = new CronScheduler({ store, wake: vi.fn() });
    await sched.init();
    const c = await store.create({ schedule: { kind: "cron", expr: "0 0 1 1 *" }, payload: "c", source: "tool", maxIterations: 100 });
    await store.delete(c.id);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sched.dueEntries().find((e) => e.id === c.id)).toBeUndefined();
    sched.dispose();
  });

  it("does not fire a stopped (capped) entry", async () => {
    const store = new CronStore(dir);
    const sched = new CronScheduler({ store, wake: vi.fn() });
    await sched.init();
    const a = await store.create({ schedule: interval(5000), payload: "a", source: "loop", maxIterations: 1 });
    await vi.advanceTimersByTimeAsync(1);

    sched.beginRun(a.id);
    const { capped } = (await store.noteRun(a.id, Date.now()))!;
    expect(capped).toBe(true);
    sched.endRun(a.id); // capped → stopped, no re-arm

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sched.dueEntries()).toHaveLength(0);
    sched.dispose();
  });

  it("on resume, re-arms a persisted interval one interval out (no immediate burst)", async () => {
    const persisted = new CronStore(dir);
    const old = await persisted.create({ schedule: interval(5000), payload: "x", source: "loop", maxIterations: 100 });

    // Resume: a fresh store on the same dir + a fresh scheduler.
    const store = new CronStore(dir);
    const sched = new CronScheduler({ store, wake: vi.fn() });
    await sched.init();

    await vi.advanceTimersByTimeAsync(1);
    expect(sched.dueEntries()).toHaveLength(0); // not immediate
    await vi.advanceTimersByTimeAsync(5000);
    expect(sched.dueEntries().map((e) => e.id)).toEqual([old.id]);
    sched.dispose();
  });

  it("dispose clears pending timers", async () => {
    const store = new CronStore(dir);
    const wake = vi.fn();
    const sched = new CronScheduler({ store, wake });
    await sched.init();
    await store.create({ schedule: interval(5000), payload: "a", source: "loop", maxIterations: 100 });
    sched.dispose();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(wake).not.toHaveBeenCalled();
  });
});
