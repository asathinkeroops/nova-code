import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CronStore, type CronEntry } from "@nova/tools";
import type { CliContext } from "../context.js";
import { handleLoop } from "./loop.js";

interface Card {
  text: string;
  opts: { title?: string; kind?: string };
}
interface Notice {
  text: string;
  tone?: string;
}

let sessionDir: string;

function makeCtx(cronStore: CronStore) {
  const cards: Card[] = [];
  const notices: Notice[] = [];
  const ctx = {
    settings: { loop: { maxIterations: 100, minIntervalMs: 1000 } },
    cronStore,
    screen: {
      card: (text: string, opts: Card["opts"] = {}) => cards.push({ text, opts }),
      notice: (text: string, _ttl?: number, tone?: string) => notices.push({ text, tone }),
    },
  } as unknown as CliContext;
  return { ctx, cards, notices };
}

async function loopEntry(store: CronStore): Promise<CronEntry | undefined> {
  return (await store.list({ source: "loop" }))[0];
}

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(tmpdir(), "nova-loop-cmd-"));
});

afterEach(async () => {
  await fs.rm(sessionDir, { recursive: true, force: true });
});

describe("handleLoop", () => {
  it("shows usage when called with no args and no active loop", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, cards } = makeCtx(store);
    await handleLoop(ctx, "");
    expect(await loopEntry(store)).toBeUndefined();
    expect(cards.at(-1)!.text).toContain("usage:");
  });

  it("starts a loop that fires immediately (interval entry, nextRunAt now)", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, cards } = makeCtx(store);
    const before = Date.now();
    await handleLoop(ctx, "5s /usage");
    const loop = await loopEntry(store);
    expect(loop).toBeDefined();
    expect(loop!.schedule).toEqual({ kind: "interval", intervalMs: 5000 });
    expect(loop!.payload).toBe("/usage");
    expect(loop!.nextRunAt).toBeGreaterThanOrEqual(before);
    expect(loop!.nextRunAt).toBeLessThanOrEqual(Date.now());
    expect(cards.at(-1)!.text).toContain("running now");
  });

  it("reports status when a loop is already running", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, cards } = makeCtx(store);
    await handleLoop(ctx, "10s do the thing");
    await handleLoop(ctx, "");
    expect(cards.at(-1)!.text).toContain("looping every 10s");
    expect(cards.at(-1)!.text).toContain("do the thing");
  });

  it("stops an active loop by deleting its entry", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, notices } = makeCtx(store);
    await handleLoop(ctx, "5s /usage");
    await handleLoop(ctx, "stop");
    expect(await loopEntry(store)).toBeUndefined();
    expect(notices.at(-1)!.text).toBe("loop stopped");
  });

  it("warns on /loop stop with no active loop", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, notices } = makeCtx(store);
    await handleLoop(ctx, "stop");
    expect(notices.at(-1)).toEqual({ text: "no active loop", tone: "warn" });
  });

  it("replaces an existing loop when a new one starts (only one at a time)", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, cards } = makeCtx(store);
    await handleLoop(ctx, "5s first");
    const first = await loopEntry(store);
    await handleLoop(ctx, "10s second");
    const all = await store.list({ source: "loop" });
    expect(all).toHaveLength(1);
    expect(all[0]!.id).not.toBe(first!.id);
    expect(all[0]!.payload).toBe("second");
    expect(cards.at(-1)!.text).toContain("replaced loop");
  });

  it("rejects an invalid interval", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, cards } = makeCtx(store);
    await handleLoop(ctx, "later do it");
    expect(await loopEntry(store)).toBeUndefined();
    expect(cards.at(-1)!.opts.kind).toBe("error");
    expect(cards.at(-1)!.text).toContain("invalid interval");
  });

  it("rejects a start with no payload", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, cards } = makeCtx(store);
    await handleLoop(ctx, "5s");
    expect(await loopEntry(store)).toBeUndefined();
    expect(cards.at(-1)!.text).toContain("missing prompt");
  });

  it("rejects an interval below minIntervalMs", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, cards } = makeCtx(store);
    ctx.settings.loop.minIntervalMs = 60_000;
    await handleLoop(ctx, "5s x");
    expect(await loopEntry(store)).toBeUndefined();
    expect(cards.at(-1)!.opts.kind).toBe("error");
    expect(cards.at(-1)!.text).toContain("too short");
  });

  it("rejects a /loop payload to prevent self-nesting", async () => {
    const store = new CronStore(sessionDir);
    const { ctx, cards } = makeCtx(store);
    await handleLoop(ctx, "5s /loop 5s x");
    expect(await loopEntry(store)).toBeUndefined();
    expect(cards.at(-1)!.text).toContain("can't run /loop");
  });
});
