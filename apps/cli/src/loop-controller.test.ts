import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopController, formatDuration, parseDuration } from "./loop-controller.js";

describe("parseDuration", () => {
  it("parses s/m/h units into milliseconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration(" 2m ")).toBe(120_000);
  });

  it("rejects bare numbers, zero, unknown units, and junk", () => {
    expect(parseDuration("5")).toBeNull();
    expect(parseDuration("0s")).toBeNull();
    expect(parseDuration("10ms")).toBeNull();
    expect(parseDuration("5d")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("-3m")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("renders the compact unit form", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(300_000)).toBe("5m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(90_000)).toBe("90s");
  });
});

describe("LoopController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(overrides: Partial<{ intervalMs: number; maxIterations: number }> = {}) {
    const enqueued: string[] = [];
    const loop = new LoopController({
      payload: "get status",
      intervalMs: overrides.intervalMs ?? 5000,
      maxIterations: overrides.maxIterations ?? 100,
      enqueue: (line) => enqueued.push(line),
    });
    return { loop, enqueued };
  }

  it("enqueues the first payload immediately on start", () => {
    const { loop, enqueued } = make();
    loop.start();
    expect(enqueued).toEqual(["get status"]);
    expect(loop.count()).toBe(1);
    loop.stop();
  });

  it("enqueues again on a steady interval", () => {
    vi.useFakeTimers();
    const { loop, enqueued } = make({ intervalMs: 5000 });
    loop.start();
    expect(enqueued).toHaveLength(1);
    vi.advanceTimersByTime(4999);
    expect(enqueued).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(enqueued).toHaveLength(2);
    vi.advanceTimersByTime(5000);
    expect(enqueued).toHaveLength(3);
    expect(loop.count()).toBe(3);
    loop.stop();
  });

  it("stops after maxIterations enqueues and fires onCap", () => {
    vi.useFakeTimers();
    const { loop, enqueued } = make({ intervalMs: 5000, maxIterations: 2 });
    const onCap = vi.fn();
    loop.onCap = onCap;
    loop.start(); // #1
    expect(enqueued).toHaveLength(1);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000); // #2 → hits cap
    expect(enqueued).toHaveLength(2);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(loop.isActive()).toBe(false);
    vi.advanceTimersByTime(60_000); // no further ticks
    expect(enqueued).toHaveLength(2);
  });

  it("stop cancels a pending tick", () => {
    vi.useFakeTimers();
    const { loop, enqueued } = make({ intervalMs: 5000 });
    loop.start(); // #1
    loop.stop();
    vi.advanceTimersByTime(20_000);
    expect(enqueued).toHaveLength(1);
    expect(loop.isActive()).toBe(false);
  });

  it("start is a no-op after stop", () => {
    const { loop, enqueued } = make();
    loop.stop();
    loop.start();
    expect(enqueued).toHaveLength(0);
  });
});
