import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CronStore, DEFAULT_CRON_LIMITS } from "./store.js";
import { createCronTools } from "./index.js";
import type { CronEntry } from "./schema.js";
import type { ToolHandler } from "@nova/core";

let sessionDir: string;

function tools(store: CronStore): { cronCreate: ToolHandler; cronList: ToolHandler; cronDelete: ToolHandler } {
  const [cronCreate, cronList, cronDelete] = createCronTools(store);
  return { cronCreate: cronCreate!, cronList: cronList!, cronDelete: cronDelete! };
}

// The dispatcher would normally supply a ToolContext; these handlers don't use it.
const ctx = {} as never;

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(tmpdir(), "nova-cron-tools-"));
});

afterEach(async () => {
  await fs.rm(sessionDir, { recursive: true, force: true });
});

describe("cronCreate", () => {
  it("creates an interval schedule and returns JSON", async () => {
    const { cronCreate } = tools(new CronStore(sessionDir));
    const res = await cronCreate.run({ schedule: "5m", payload: "check the build" }, ctx);
    expect(res.isError).toBeFalsy();
    const entry = JSON.parse(res.output) as CronEntry;
    expect(entry.schedule).toEqual({ kind: "interval", intervalMs: 300_000 });
    expect(entry.source).toBe("tool");
  });

  it("creates a cron schedule", async () => {
    const { cronCreate } = tools(new CronStore(sessionDir));
    const res = await cronCreate.run({ schedule: "0 9 * * *", payload: "standup" }, ctx);
    const entry = JSON.parse(res.output) as CronEntry;
    expect(entry.schedule).toEqual({ kind: "cron", expr: "0 9 * * *" });
  });

  it("rejects an invalid schedule", async () => {
    const { cronCreate } = tools(new CronStore(sessionDir));
    const res = await cronCreate.run({ schedule: "banana", payload: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/invalid schedule/);
  });

  it("rejects self-nesting /loop and /cron payloads", async () => {
    const { cronCreate } = tools(new CronStore(sessionDir));
    for (const payload of ["/loop 5s foo", "/cron whatever"]) {
      const res = await cronCreate.run({ schedule: "5m", payload }, ctx);
      expect(res.isError).toBe(true);
      expect(res.output).toMatch(/can't run \/loop or \/cron/);
    }
  });

  it("rejects intervals below the minimum", async () => {
    const store = new CronStore(sessionDir, { ...DEFAULT_CRON_LIMITS, minIntervalMs: 60_000 });
    const { cronCreate } = tools(store);
    const res = await cronCreate.run({ schedule: "5s", payload: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/interval too short/);
  });

  it("enforces maxSchedules", async () => {
    const store = new CronStore(sessionDir, { ...DEFAULT_CRON_LIMITS, maxSchedules: 1 });
    const { cronCreate } = tools(store);
    expect((await cronCreate.run({ schedule: "5m", payload: "a" }, ctx)).isError).toBeFalsy();
    const res = await cronCreate.run({ schedule: "5m", payload: "b" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/too many schedules/);
  });
});

describe("cronList", () => {
  it("returns all entries and filters by status", async () => {
    const store = new CronStore(sessionDir);
    const t = tools(store);
    await t.cronCreate.run({ schedule: "5m", payload: "a" }, ctx);
    const b = JSON.parse((await t.cronCreate.run({ schedule: "5m", payload: "b" }, ctx)).output) as CronEntry;
    await store.stop(b.id);

    const all = JSON.parse((await t.cronList.run({}, ctx)).output) as CronEntry[];
    expect(all).toHaveLength(2);
    const active = JSON.parse((await t.cronList.run({ status: "active" }, ctx)).output) as CronEntry[];
    expect(active.map((e) => e.payload)).toEqual(["a"]);
  });
});

describe("cronDelete", () => {
  it("deletes an existing schedule", async () => {
    const store = new CronStore(sessionDir);
    const t = tools(store);
    const e = JSON.parse((await t.cronCreate.run({ schedule: "5m", payload: "a" }, ctx)).output) as CronEntry;
    const res = await t.cronDelete.run({ id: e.id }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toMatch(/deleted schedule/);
  });

  it("returns a clean error for an unknown id", async () => {
    const { cronDelete } = tools(new CronStore(sessionDir));
    const res = await cronDelete.run({ id: "nope" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/no schedule with id/);
  });
});
