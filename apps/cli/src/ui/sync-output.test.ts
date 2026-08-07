import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { wrapStdout } from "./sync-output.js";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const SAVE = "\x1b7";
const RESTORE = "\x1b8";
const SHOW = "\x1b[?25h";
const HIDE = "\x1b[?25l";

/** Minimal WriteStream stand-in that records what was written. */
function fakeStream(): NodeJS.WriteStream & { writes: string[] } {
  const writes: string[] = [];
  const stream = {
    writes,
    columns: 120,
    rows: 40,
    isTTY: true,
    write(chunk: unknown): boolean {
      writes.push(String(chunk));
      return true;
    },
  };
  return stream as unknown as NodeJS.WriteStream & { writes: string[] };
}

describe("wrapStdout", () => {
  it("brackets each string frame in synchronized-output markers when sync is on", () => {
    const base = fakeStream();
    const out = wrapStdout(base, { sync: true });
    out.write("FRAME");
    expect(base.writes).toEqual([`${BSU}FRAME${ESU}`]);
  });

  it("omits the sync markers when sync is off and no cursor tracking", () => {
    const base = fakeStream();
    const out = wrapStdout(base, { sync: false });
    out.write("FRAME");
    expect(base.writes).toEqual(["FRAME"]);
  });

  it("sandwiches the frame in restore/save and parks the cursor on the target", () => {
    const base = fakeStream();
    const out = wrapStdout(base, { sync: true, getCursor: () => ({ row: 7, col: 12 }) });
    out.write("FRAME");
    // restore before the frame (Ink's erase runs from its prior end), save after
    // (remember the new end), then move to the caret and show the cursor — all
    // inside the synchronized-update brackets.
    expect(base.writes).toEqual([`${BSU}${RESTORE}FRAME${SAVE}\x1b[7;12H${SHOW}${ESU}`]);
  });

  it("hides the cursor (no move) when the target is null but tracking is on", () => {
    const base = fakeStream();
    const out = wrapStdout(base, { sync: false, getCursor: () => null });
    out.write("FRAME");
    expect(base.writes).toEqual([`${RESTORE}FRAME${SAVE}${HIDE}`]);
  });

  it("reads the cursor target fresh on every write", () => {
    const base = fakeStream();
    let target: { row: number; col: number } | null = { row: 1, col: 1 };
    const out = wrapStdout(base, { sync: false, getCursor: () => target });
    out.write("A");
    target = { row: 2, col: 5 };
    out.write("B");
    expect(base.writes[0]).toContain("\x1b[1;1H");
    expect(base.writes[1]).toContain("\x1b[2;5H");
  });

  it("reports the target each written frame parked on via onPark", () => {
    const base = fakeStream();
    const parked: ({ row: number; col: number } | null)[] = [];
    let target: { row: number; col: number } | null = { row: 3, col: 4 };
    const out = wrapStdout(base, {
      sync: false,
      getCursor: () => target,
      onPark: (t) => parked.push(t),
    });
    out.write("A");
    target = null;
    out.write("B");
    expect(parked).toEqual([{ row: 3, col: 4 }, null]);
  });

  it("does not call onPark when cursor tracking is off", () => {
    const base = fakeStream();
    const parked: unknown[] = [];
    const out = wrapStdout(base, { sync: true, onPark: (t) => parked.push(t) });
    out.write("FRAME");
    expect(parked).toEqual([]);
  });

  it("passes non-string chunks through untouched", () => {
    const base = fakeStream();
    const out = wrapStdout(base, { sync: true, getCursor: () => ({ row: 1, col: 1 }) });
    const buf = Buffer.from("raw");
    out.write(buf as unknown as string);
    expect(base.writes).toEqual(["raw"]);
  });

  it("writes through a real Writable (write must be bound to the stream)", () => {
    // The plain-object fake above can't catch this: Node's real Writable.write
    // reads `this._writableState`, so an unbound call throws. Mirrors process.stdout.
    const chunks: string[] = [];
    const real = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
        return true;
      },
    }) as unknown as NodeJS.WriteStream;
    const out = wrapStdout(real, { sync: true });
    expect(() => out.write("FRAME")).not.toThrow();
    expect(chunks).toEqual([`${BSU}FRAME${ESU}`]);
  });

  it("forwards stream properties like columns/rows/isTTY", () => {
    const base = fakeStream();
    const out = wrapStdout(base, { sync: true });
    expect(out.columns).toBe(120);
    expect(out.rows).toBe(40);
    expect(out.isTTY).toBe(true);
  });
});
