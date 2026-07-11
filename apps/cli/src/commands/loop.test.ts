import { describe, expect, it } from "vitest";
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

function makeCtx() {
  const cards: Card[] = [];
  const notices: Notice[] = [];
  const enqueued: string[] = [];
  const ctx = {
    settings: { loop: { maxIterations: 100, minIntervalMs: 1000 } },
    loop: null,
    screen: {
      card: (text: string, opts: Card["opts"] = {}) => cards.push({ text, opts }),
      notice: (text: string, _ttl?: number, tone?: string) => notices.push({ text, tone }),
      enqueueInput: (line: string) => enqueued.push(line),
    },
  } as unknown as CliContext;
  return { ctx, cards, notices, enqueued };
}

describe("handleLoop", () => {
  it("shows usage when called with no args and no active loop", async () => {
    const { ctx, cards } = makeCtx();
    await handleLoop(ctx, "");
    expect(ctx.loop).toBeNull();
    expect(cards.at(-1)!.text).toContain("usage:");
  });

  it("starts a loop for a valid interval + payload and enqueues immediately", async () => {
    const { ctx, cards, enqueued } = makeCtx();
    await handleLoop(ctx, "5s /usage");
    expect(ctx.loop).not.toBeNull();
    expect(ctx.loop!.intervalMs).toBe(5000);
    expect(ctx.loop!.payload).toBe("/usage");
    expect(enqueued).toEqual(["/usage"]); // start() enqueues the first tick now
    expect(ctx.loop!.count()).toBe(1);
    expect(cards.at(-1)!.text).toContain("running now");
    ctx.loop!.stop();
  });

  it("reports status when a loop is already running", async () => {
    const { ctx, cards } = makeCtx();
    await handleLoop(ctx, "10s do the thing");
    await handleLoop(ctx, "");
    expect(cards.at(-1)!.text).toContain("looping every 10s");
    expect(cards.at(-1)!.text).toContain("do the thing");
    ctx.loop!.stop();
  });

  it("stops an active loop and clears ctx.loop", async () => {
    const { ctx, notices } = makeCtx();
    await handleLoop(ctx, "5s /usage");
    await handleLoop(ctx, "stop");
    expect(ctx.loop).toBeNull();
    expect(notices.at(-1)!.text).toBe("loop stopped");
  });

  it("warns on /loop stop with no active loop", async () => {
    const { ctx, notices } = makeCtx();
    await handleLoop(ctx, "stop");
    expect(notices.at(-1)).toEqual({ text: "no active loop", tone: "warn" });
  });

  it("replaces an existing loop when a new one starts", async () => {
    const { ctx, cards } = makeCtx();
    await handleLoop(ctx, "5s first");
    const first = ctx.loop;
    await handleLoop(ctx, "10s second");
    expect(ctx.loop).not.toBe(first);
    expect(ctx.loop!.payload).toBe("second");
    expect(cards.at(-1)!.text).toContain("replaced loop");
    ctx.loop!.stop();
  });

  it("rejects an invalid interval", async () => {
    const { ctx, cards } = makeCtx();
    await handleLoop(ctx, "later do it");
    expect(ctx.loop).toBeNull();
    expect(cards.at(-1)!.opts.kind).toBe("error");
    expect(cards.at(-1)!.text).toContain("invalid interval");
  });

  it("rejects a start with no payload", async () => {
    const { ctx, cards } = makeCtx();
    await handleLoop(ctx, "5s");
    expect(ctx.loop).toBeNull();
    expect(cards.at(-1)!.text).toContain("missing prompt");
  });

  it("rejects an interval below minIntervalMs", async () => {
    const { ctx, cards } = makeCtx();
    ctx.settings.loop.minIntervalMs = 60_000;
    await handleLoop(ctx, "5s x");
    expect(ctx.loop).toBeNull();
    expect(cards.at(-1)!.opts.kind).toBe("error");
    expect(cards.at(-1)!.text).toContain("too short");
  });

  it("rejects a /loop payload to prevent self-nesting", async () => {
    const { ctx, cards } = makeCtx();
    await handleLoop(ctx, "5s /loop 5s x");
    expect(ctx.loop).toBeNull();
    expect(cards.at(-1)!.text).toContain("can't run /loop");
  });
});
