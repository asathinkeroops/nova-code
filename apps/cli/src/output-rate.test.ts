import { describe, expect, it } from "vitest";
import { createOutputRateTracker } from "./output-rate.js";

describe("createOutputRateTracker", () => {
  it("reports no live rate before any output", () => {
    const t = createOutputRateTracker();
    expect(t.liveRate()).toBeNull();
  });

  it("ignores zero-output chunks (prompt upload) for the window start", () => {
    const t = createOutputRateTracker();
    t.onProgress(0, 1_000);
    t.onProgress(10, 2_000);
    t.onProgress(110, 3_000);
    // Window starts at the first *output* chunk (2000), not the prompt one.
    expect(t.liveRate()).toBeCloseTo(110, 5);
  });

  it("withholds the live rate while the window is too young", () => {
    const t = createOutputRateTracker();
    t.onProgress(5, 0);
    t.onProgress(40, 300);
    expect(t.liveRate()).toBeNull();
  });

  it("reports an average over the streaming window once it matures", () => {
    const t = createOutputRateTracker();
    t.onProgress(50, 0);
    t.onProgress(150, 1_000);
    t.onProgress(300, 2_000);
    expect(t.liveRate()).toBeCloseTo(150, 5);
  });

  it("settles with the authoritative token count over the streaming window", () => {
    const t = createOutputRateTracker();
    t.onProgress(100, 0);
    t.onProgress(500, 2_000);
    // Live estimate said 500; the final usage says 520 — the window is what
    // matters, and the settled number uses the authoritative count.
    expect(t.finish(520, 9_000)).toBeCloseTo(260, 5);
  });

  it("falls back to the request duration when the window is too short", () => {
    const t = createOutputRateTracker();
    t.onProgress(20, 0);
    t.onProgress(60, 100);
    // 60 tokens over a 2s request → 30 tok/s, not 600.
    expect(t.finish(60, 2_000)).toBeCloseTo(30, 5);
  });

  it("falls back to the request duration when nothing streamed", () => {
    const t = createOutputRateTracker();
    expect(t.finish(120, 3_000)).toBeCloseTo(40, 5);
  });

  it("returns null for a request that produced no output", () => {
    const t = createOutputRateTracker();
    t.onProgress(0, 0);
    expect(t.finish(0, 5_000)).toBeNull();
  });

  it("resets after settling so the next request starts a fresh window", () => {
    const t = createOutputRateTracker();
    t.onProgress(100, 0);
    t.onProgress(400, 1_000);
    expect(t.finish(400, 1_000)).toBeCloseTo(400, 5);
    expect(t.liveRate()).toBeNull();
    t.onProgress(10, 60_000);
    t.onProgress(310, 61_000);
    expect(t.liveRate()).toBeCloseTo(310, 5);
  });

  it("drops the window on reset without reporting", () => {
    const t = createOutputRateTracker();
    t.onProgress(100, 0);
    t.onProgress(400, 1_000);
    t.reset();
    expect(t.liveRate()).toBeNull();
    // The old window is gone: a lone chunk can't produce a rate.
    t.onProgress(20, 5_000);
    expect(t.liveRate()).toBeNull();
  });
});
