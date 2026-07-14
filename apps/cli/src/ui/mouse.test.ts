import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasteResolver, createWheelThrottle, extractJumpToBottom } from "./mouse.js";

const START = "\x1b[200~";
const END = "\x1b[201~";
const CTRL_V = "\x16";

describe("extractJumpToBottom", () => {
  it("detects and strips ctrl+End and End variants", () => {
    for (const seq of ["\x1b[1;5F", "\x1b[F", "\x1bOF", "\x1b[4~"]) {
      expect(extractJumpToBottom(seq)).toEqual({ rest: "", jumped: true });
    }
  });

  it("leaves ordinary input untouched", () => {
    expect(extractJumpToBottom("hello")).toEqual({ rest: "hello", jumped: false });
    expect(extractJumpToBottom("")).toEqual({ rest: "", jumped: false });
  });

  it("strips the sequence but keeps surrounding bytes", () => {
    expect(extractJumpToBottom("ab\x1b[1;5Fcd")).toEqual({ rest: "abcd", jumped: true });
  });
});

describe("createPasteResolver", () => {
  it("passes ordinary typing through untouched", () => {
    const r = createPasteResolver();
    expect(r("hello")).toBe("hello");
    expect(r(" world")).toBe(" world");
  });

  it("strips markers from a text paste, keeping the inner text", () => {
    const r = createPasteResolver();
    expect(r(`${START}pasted text${END}`)).toBe("pasted text");
  });

  it("turns an empty paste into a synthetic Ctrl+V (image gesture)", () => {
    const r = createPasteResolver();
    expect(r(`${START}${END}`)).toBe(CTRL_V);
  });

  it("preserves text surrounding a paste block", () => {
    const r = createPasteResolver();
    expect(r(`a${START}b${END}c`)).toBe("abc");
    const r2 = createPasteResolver();
    expect(r2(`x${START}${END}y`)).toBe(`x${CTRL_V}y`);
  });

  it("resolves a paste whose body spans multiple chunks", () => {
    const r = createPasteResolver();
    expect(r(`${START}foo`)).toBe("");
    expect(r("bar")).toBe("");
    expect(r(`baz${END}`)).toBe("foobarbaz");
  });

  it("resolves a start marker split across chunks without leaking it as text", () => {
    const r = createPasteResolver();
    expect(r("hi\x1b[2")).toBe("hi");
    expect(r(`00~body${END}`)).toBe("body");
  });

  it("resolves an end marker split across chunks", () => {
    const r = createPasteResolver();
    expect(r(`${START}body\x1b[20`)).toBe("");
    expect(r("1~tail")).toBe("bodytail");
  });

  it("handles an empty paste split across chunks", () => {
    const r = createPasteResolver();
    expect(r(START)).toBe("");
    expect(r(END)).toBe(CTRL_V);
  });
});

describe("createWheelThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // No decay + a high ceiling → the whole burst is eventually emitted (easy to
  // reason about). Tests that exercise the ceiling override maxPending locally.
  const OPTS = {
    intervalMs: 10,
    releaseFraction: 0.5,
    minStep: 3,
    maxStep: 100,
    decay: 1,
    maxPending: 10_000,
  };

  /** Advance well past drain and return every delta emitted, in order. */
  function drain(emit: ReturnType<typeof vi.fn>): number[] {
    vi.advanceTimersByTime(10_000);
    return emit.mock.calls.map((c) => c[0] as number);
  }

  it("emits a lone notch synchronously (no lag on the leading edge)", () => {
    const emit = vi.fn();
    const t = createWheelThrottle(emit, OPTS);
    t.push(3);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(3);
  });

  it("releases a burst with deceleration, conserving distance when decay=1", () => {
    const emit = vi.fn();
    const t = createWheelThrottle(emit, OPTS);
    for (let i = 0; i < 20; i++) t.push(3); // 60 lines requested
    // Leading edge emits the first notch instantly; the rest accumulates.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(3);

    const steps = drain(emit);
    // Full distance is preserved (nothing dropped) ...
    expect(steps.reduce((a, b) => a + b, 0)).toBe(60);
    // ... released over several frames, not one jump ...
    expect(steps.length).toBeGreaterThan(3);
    // ... and each frame after the leading notch is non-increasing (ease-out).
    const tail = steps.slice(1);
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]!).toBeLessThanOrEqual(tail[i - 1]!);
    }
    // Never crawls below one notch until the final remainder.
    for (const s of tail.slice(0, -1)) expect(s).toBeGreaterThanOrEqual(3);
  });

  it("decay bleeds off a hard fling so it travels less than requested", () => {
    const emit = vi.fn();
    const t = createWheelThrottle(emit, { ...OPTS, decay: 0.8 });
    for (let i = 0; i < 40; i++) t.push(3); // 120 lines requested
    const total = drain(emit).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(3); // still real momentum, not killed
    expect(total).toBeLessThan(120); // but overshoot is bounded
  });

  it("caps total travel at maxPending no matter how hard the fling", () => {
    const emit = vi.fn();
    // decay=1 so nothing is shed → total equals whatever the ceiling allowed.
    const t = createWheelThrottle(emit, { ...OPTS, decay: 1, maxPending: 24 });
    for (let i = 0; i < 200; i++) t.push(3); // 600 lines requested — absurd fling
    const total = drain(emit).reduce((a, b) => a + b, 0);
    // The leading notch (minStep) emits before the burst accumulates, so the
    // ceiling bounds travel to maxPending + one notch — still tightly controlled.
    expect(total).toBeLessThanOrEqual(24 + 3);
    expect(total).toBeGreaterThan(3); // still scrolls a controlled amount
  });

  it("caps the peak frame so the first release isn't a giant jump", () => {
    const emit = vi.fn();
    const t = createWheelThrottle(emit, { ...OPTS, maxStep: 9 });
    for (let i = 0; i < 100; i++) t.push(3); // huge fling
    const steps = drain(emit);
    for (const s of steps) expect(Math.abs(s)).toBeLessThanOrEqual(9);
  });

  it("preserves direction for negative (upward) bursts", () => {
    const emit = vi.fn();
    const t = createWheelThrottle(emit, OPTS);
    for (let i = 0; i < 10; i++) t.push(-3);
    const steps = drain(emit);
    for (const s of steps) expect(s).toBeLessThan(0);
    expect(steps.reduce((a, b) => a + b, 0)).toBe(-30);
  });

  it("emits each notch instantly when they are spaced beyond the window", () => {
    const emit = vi.fn();
    const t = createWheelThrottle(emit, OPTS);
    t.push(3);
    vi.advanceTimersByTime(10); // idle flush clears the timer
    t.push(3);
    const steps = emit.mock.calls.map((c) => c[0] as number);
    expect(steps).toEqual([3, 3]);
  });

  it("dispose cancels the pending drain and drops accumulated delta", () => {
    const emit = vi.fn();
    const t = createWheelThrottle(emit, OPTS);
    t.push(3); // leading emit
    t.push(3); // accumulates for the next frame
    t.dispose();
    vi.advanceTimersByTime(10_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(3);
  });

  it("ignores zero deltas", () => {
    const emit = vi.fn();
    const t = createWheelThrottle(emit, OPTS);
    t.push(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
