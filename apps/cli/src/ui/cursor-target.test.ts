import { afterEach, describe, expect, it } from "vitest";
import {
  getCursorTarget,
  markCursorPainted,
  setCursorTarget,
  setCursorWriter,
} from "./cursor-target.js";

/** Let the pending `setImmediate` flush run. */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  setCursorWriter(null);
  setCursorTarget(null);
});

describe("cursor-target out-of-band parking", () => {
  it("moves the real cursor when no frame carried the new target", async () => {
    const seqs: string[] = [];
    setCursorWriter((s) => seqs.push(s));

    setCursorTarget({ row: 20, col: 9 });
    await drain();
    expect(seqs).toEqual(["\x1b[20;9H\x1b[?25h"]);

    // A caret-only move (←) — Ink emits no frame, so this module must.
    setCursorTarget({ row: 20, col: 8 });
    await drain();
    expect(seqs).toEqual(["\x1b[20;9H\x1b[?25h", "\x1b[20;8H\x1b[?25h"]);
  });

  it("stays quiet when the frame already parked the cursor on the target", async () => {
    const seqs: string[] = [];
    setCursorWriter((s) => seqs.push(s));

    const target = { row: 5, col: 3 };
    setCursorTarget(target);
    // The stdout wrapper writes the frame (and its own park) before the deferred
    // flush runs, and reports it via `onPark`.
    markCursorPainted(target);
    await drain();
    expect(seqs).toEqual([]);
  });

  it("coalesces several moves within one tick into a single park", async () => {
    const seqs: string[] = [];
    setCursorWriter((s) => seqs.push(s));

    setCursorTarget({ row: 1, col: 1 });
    setCursorTarget({ row: 1, col: 2 });
    setCursorTarget({ row: 1, col: 3 });
    await drain();
    expect(seqs).toEqual(["\x1b[1;3H\x1b[?25h"]);
  });

  it("hides the cursor when the caret goes away (a modal takes over)", async () => {
    const seqs: string[] = [];
    setCursorWriter((s) => seqs.push(s));

    setCursorTarget({ row: 4, col: 4 });
    await drain();
    seqs.length = 0;

    setCursorTarget(null);
    await drain();
    expect(seqs).toEqual(["\x1b[?25l"]);
  });

  it("writes nothing when parking is off, but still tracks the target", async () => {
    const seqs: string[] = [];
    setCursorWriter(null);
    setCursorTarget({ row: 2, col: 2 });
    await drain();
    expect(seqs).toEqual([]);
    expect(getCursorTarget()).toEqual({ row: 2, col: 2 });
  });

  it("cancels a scheduled park when the writer is torn down", async () => {
    const seqs: string[] = [];
    setCursorWriter((s) => seqs.push(s));
    setCursorTarget({ row: 9, col: 9 });
    setCursorWriter(null);
    await drain();
    expect(seqs).toEqual([]);
  });
});
