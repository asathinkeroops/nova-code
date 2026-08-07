/**
 * End-to-end guard for the real terminal caret: pressing ←/→ must actually move
 * the cursor on screen.
 *
 * With cursor parking live the InputBox draws no caret cell of its own (the
 * terminal's cursor *is* the caret), so a caret-only move renders byte-identical
 * output — and Ink skips `stdout.write` for identical frames. Without the
 * out-of-band park in `cursor-target.ts` nothing reaches the terminal at all and
 * the cursor sits stranded at its previous column until some unrelated repaint
 * drags it along. This test wires Ink the way `Screen.mount` does and asserts a
 * real cursor-move escape lands after each arrow key.
 */
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { InputBox } from "./input-box.js";
import {
  getCursorTarget,
  markCursorPainted,
  setCursorParking,
  setCursorTarget,
  setCursorWriter,
} from "./cursor-target.js";
import { wrapStdout } from "./sync-output.js";

const COLUMNS = 80;
const ROWS = 24;
/** Absolute row/col of a caret move, from the last `CSI row;col H` written. */
const MOVE_RE = /\x1b\[(\d+);(\d+)H/g; // eslint-disable-line no-control-regex

function lastCaretMove(writes: string[]): { row: number; col: number } | null {
  const all = writes.join("");
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  MOVE_RE.lastIndex = 0;
  while ((m = MOVE_RE.exec(all)) !== null) last = m;
  if (!last) return null;
  return { row: Number(last[1]), col: Number(last[2]) };
}

function fakeStdout(writes: string[]): NodeJS.WriteStream {
  const stream = new PassThrough();
  Object.assign(stream, {
    columns: COLUMNS,
    rows: ROWS,
    isTTY: true,
    write: (chunk: unknown): boolean => {
      if (typeof chunk === "string") writes.push(chunk);
      return true;
    },
  });
  return stream as unknown as NodeJS.WriteStream;
}

function fakeStdin(): PassThrough & NodeJS.ReadStream {
  const stream = new PassThrough();
  Object.assign(stream, {
    isTTY: true,
    setRawMode: () => stream,
    ref: () => stream,
    unref: () => stream,
  });
  return stream as unknown as PassThrough & NodeJS.ReadStream;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  setCursorWriter(null);
  setCursorTarget(null);
  setCursorParking(false);
});

describe("real caret follows ←/→", () => {
  it("emits a cursor move for an arrow key even though the frame is unchanged", async () => {
    const writes: string[] = [];
    const base = fakeStdout(writes);
    setCursorParking(true);
    // Mirrors Screen.mount: the wrapper parks on each frame it writes, and the
    // raw-stream writer covers the frames Ink never writes.
    setCursorWriter((seq) => void base.write(seq));
    const stdout = wrapStdout(base, {
      sync: true,
      getCursor: getCursorTarget,
      onPark: markCursorPainted,
    });

    const stdin = fakeStdin();
    const inst = render(
      React.createElement(InputBox, {
        options: { width: COLUMNS },
        onSubmit: () => undefined,
        onCancel: () => undefined,
        cursorTracking: { termRows: ROWS, bottomChromeRows: 2 },
      }),
      { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
    );

    try {
      stdin.write("hello");
      await tick();
      // Caret sits after "hello": col 1 (pad) + 2 (prompt) + 5 + 1.
      expect(lastCaretMove(writes)).toEqual({ row: 20, col: 9 });

      writes.length = 0;
      stdin.write("\x1b[D");
      await tick();
      expect(getCursorTarget()).toEqual({ row: 20, col: 8 });
      expect(lastCaretMove(writes)).toEqual({ row: 20, col: 8 });

      writes.length = 0;
      stdin.write("\x1b[C");
      await tick();
      expect(lastCaretMove(writes)).toEqual({ row: 20, col: 9 });

      // Ctrl+A / Ctrl+E are caret-only too, and equally invisible without this.
      writes.length = 0;
      stdin.write("\x01");
      await tick();
      expect(lastCaretMove(writes)).toEqual({ row: 20, col: 4 });
    } finally {
      inst.unmount();
    }
  });
});
