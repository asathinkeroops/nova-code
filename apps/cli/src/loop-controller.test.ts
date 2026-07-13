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
    const wake = vi.fn();
    const loop = new LoopController({
      payload: "get status",
      intervalMs: overrides.intervalMs ?? 5000,
      maxIterations: overrides.maxIterations ?? 100,
      wake,
    });
    return { loop, wake };
  }

  it("armFirst marks the first iteration due immediately, no timer", () => {
    const { loop, wake } = make();
    expect(loop.isDue()).toBe(false);
    loop.armFirst();
    expect(loop.isDue()).toBe(true);
    expect(wake).not.toHaveBeenCalled();
  });

  it("noteIteration consumes the due flag and counts", () => {
    const { loop } = make();
    loop.armFirst();
    expect(loop.noteIteration()).toBe(false);
    expect(loop.isDue()).toBe(false);
    expect(loop.count()).toBe(1);
  });

  it("re-arms one interval after completion (completion-relative)", () => {
    vi.useFakeTimers();
    const { loop, wake } = make({ intervalMs: 5000 });
    loop.armFirst();
    loop.noteIteration(); // iteration ran
    loop.rearm(); // called by the REPL after the turn completes
    expect(loop.isDue()).toBe(false);
    vi.advanceTimersByTime(4999);
    expect(loop.isDue()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(loop.isDue()).toBe(true);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("noteIteration reports the cap so the caller stops instead of re-arming", () => {
    const { loop } = make({ maxIterations: 2 });
    loop.armFirst();
    expect(loop.noteIteration()).toBe(false); // 1/2
    loop.armFirst();
    expect(loop.noteIteration()).toBe(true); // 2/2 → capped
    expect(loop.count()).toBe(2);
  });

  it("stop cancels a pending re-armed tick", () => {
    vi.useFakeTimers();
    const { loop, wake } = make({ intervalMs: 5000 });
    loop.rearm();
    loop.stop();
    vi.advanceTimersByTime(20_000);
    expect(loop.isDue()).toBe(false);
    expect(loop.isActive()).toBe(false);
    expect(wake).not.toHaveBeenCalled();
  });

  it("armFirst and rearm are no-ops after stop", () => {
    vi.useFakeTimers();
    const { loop, wake } = make();
    loop.stop();
    loop.armFirst();
    expect(loop.isDue()).toBe(false);
    loop.rearm();
    vi.advanceTimersByTime(10_000);
    expect(wake).not.toHaveBeenCalled();
  });
});
