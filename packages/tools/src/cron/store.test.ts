import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStore } from "./store.js";
import type { ScheduleSpec } from "./schema.js";

const INTERVAL: ScheduleSpec = { kind: "interval", intervalMs: 5_000 };
let sessionDir: string;

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(tmpdir(), "nova-cron-store-"));
});

afterEach(async () => {
  await fs.rm(sessionDir, { recursive: true, force: true });
});

describe("CronStore.create", () => {
  it("creates an active entry, fires interval immediately, persists to disk", async () => {
    const store = new CronStore(sessionDir);
    const before = Date.now();
    const e = await store.create({
      schedule: INTERVAL,
      payload: "/usage",
      source: "loop",
      maxIterations: 100,
    });
    expect(e.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(e.status).toBe("active");
    expect(e.isCommand).toBe(true);
    expect(e.iterations).toBe(0);
    // Interval entries fire immediately (nextRunAt ≈ now).
    expect(e.nextRunAt).toBeGreaterThanOrEqual(before);
    expect(e.nextRunAt).toBeLessThanOrEqual(Date.now());

    const onDisk = JSON.parse(
      await fs.readFile(path.join(sessionDir, "cron", `${e.id}.json`), "utf8"),
    );
    expect(onDisk).toEqual(e);
  });

  it("marks a non-slash payload as not a command", async () => {
    const store = new CronStore(sessionDir);
    const e = await store.create({ schedule: INTERVAL, payload: "check the build", source: "tool", maxIterations: 100 });
    expect(e.isCommand).toBe(false);
  });

  it("computes the next matching minute for cron schedules", async () => {
    const store = new CronStore(sessionDir);
    const e = await store.create({
      schedule: { kind: "cron", expr: "0 9 * * *" },
      payload: "daily standup",
      source: "tool",
      maxIterations: 100,
    });
    expect(new Date(e.nextRunAt!).getHours()).toBe(9);
    expect(new Date(e.nextRunAt!).getMinutes()).toBe(0);
  });

  it("throws on a cron expression that never fires", async () => {
    const store = new CronStore(sessionDir);
    await expect(
      store.create({ schedule: { kind: "cron", expr: "0 0 30 2 *" }, payload: "x", source: "tool", maxIterations: 100 }),
    ).rejects.toThrow(/never fires/);
  });
});

describe("CronStore persistence round-trip", () => {
  it("reloads entries from disk into a fresh store", async () => {
    const store = new CronStore(sessionDir);
    const a = await store.create({ schedule: INTERVAL, payload: "a", source: "tool", maxIterations: 100 });
    const b = await store.create({ schedule: { kind: "cron", expr: "*/15 * * * *" }, payload: "b", source: "tool", maxIterations: 100 });

    const fresh = new CronStore(sessionDir);
    const reloaded = await fresh.list();
    expect(reloaded.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("skips corrupt files on load", async () => {
    const store = new CronStore(sessionDir);
    const good = await store.create({ schedule: INTERVAL, payload: "good", source: "tool", maxIterations: 100 });
    await fs.writeFile(path.join(sessionDir, "cron", "junk.json"), "{ not json", "utf8");

    const fresh = new CronStore(sessionDir);
    const reloaded = await fresh.list();
    expect(reloaded.map((e) => e.id)).toEqual([good.id]);
  });
});

describe("CronStore.list filters", () => {
  it("filters by status and source", async () => {
    const store = new CronStore(sessionDir);
    const loop = await store.create({ schedule: INTERVAL, payload: "loop", source: "loop", maxIterations: 100 });
    const tool = await store.create({ schedule: INTERVAL, payload: "tool", source: "tool", maxIterations: 100 });
    await store.stop(tool.id);

    expect((await store.list({ source: "loop" })).map((e) => e.id)).toEqual([loop.id]);
    expect((await store.list({ status: "stopped" })).map((e) => e.id)).toEqual([tool.id]);
    expect((await store.list({ status: "active" })).map((e) => e.id)).toEqual([loop.id]);
  });
});

describe("CronStore.noteRun", () => {
  it("increments iterations and reports the cap, flipping to stopped", async () => {
    const store = new CronStore(sessionDir);
    const e = await store.create({ schedule: INTERVAL, payload: "x", source: "loop", maxIterations: 2 });
    const first = await store.noteRun(e.id, Date.now());
    expect(first!.capped).toBe(false);
    expect(first!.entry.iterations).toBe(1);
    const second = await store.noteRun(e.id, Date.now());
    expect(second!.capped).toBe(true);
    expect(second!.entry.status).toBe("stopped");
    expect(second!.entry.nextRunAt).toBeNull();
  });

  it("returns undefined for an unknown id", async () => {
    const store = new CronStore(sessionDir);
    expect(await store.noteRun("nope", Date.now())).toBeUndefined();
  });
});

describe("CronStore.reschedule", () => {
  it("advances an interval entry completion-relative", async () => {
    const store = new CronStore(sessionDir);
    const e = await store.create({ schedule: INTERVAL, payload: "x", source: "loop", maxIterations: 100 });
    const from = Date.now();
    const updated = await store.reschedule(e.id, from);
    expect(updated!.nextRunAt).toBe(from + 5_000);
  });

  it("does not touch a stopped entry", async () => {
    const store = new CronStore(sessionDir);
    const e = await store.create({ schedule: INTERVAL, payload: "x", source: "loop", maxIterations: 100 });
    await store.stop(e.id);
    expect(await store.reschedule(e.id, Date.now())).toBeUndefined();
  });
});

describe("CronStore.onChange", () => {
  it("notifies listeners on every mutation and can unsubscribe", async () => {
    const store = new CronStore(sessionDir);
    const fn = vi.fn();
    const off = store.onChange(fn);
    const e = await store.create({ schedule: INTERVAL, payload: "x", source: "loop", maxIterations: 100 });
    expect(fn).toHaveBeenCalledTimes(1);
    await store.stop(e.id);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    await store.delete(e.id);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("CronStore.delete", () => {
  it("removes the entry and its file, returning whether it existed", async () => {
    const store = new CronStore(sessionDir);
    const e = await store.create({ schedule: INTERVAL, payload: "x", source: "tool", maxIterations: 100 });
    expect(await store.delete(e.id)).toBe(true);
    expect(await store.delete(e.id)).toBe(false);
    await expect(fs.access(path.join(sessionDir, "cron", `${e.id}.json`))).rejects.toThrow();
  });
});
