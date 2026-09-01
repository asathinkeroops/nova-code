/**
 * End-to-end guard for ↑/↓ navigation in a multi-line InputBox buffer.
 *
 * With a buffer that wraps onto more than one display line, ↑/↓ must move the
 * caret between rows (keeping its visual column) instead of always recalling
 * history — history recall is reserved for the edges: ↑ on the first row walks
 * back into older prompts, ↓ on the last row walks forward / restores the draft.
 * A single-line buffer keeps the old shell-like behaviour (↑/↓ always recall).
 */
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { InputBox, type InputBoxProps } from "./input-box.js";
import {
  getCursorTarget,
  markCursorPainted,
  setCursorParking,
  setCursorTarget,
  setCursorWriter,
} from "./cursor-target.js";
import { wrapStdout } from "./sync-output.js";
import { stripAnsi } from "./width.js";

const COLUMNS = 80;
const ROWS = 24;

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

/**
 * Mount an InputBox wired the way Screen does for the permanent bottom-pinned
 * box (real caret parking), returning the live instance and the accumulated raw
 * frame writes.
 */
function mountInputBox(
  writes: string[],
  options: InputBoxProps["options"] = {},
): { inst: ReturnType<typeof render>; stdin: PassThrough & NodeJS.ReadStream } {
  const base = fakeStdout(writes);
  setCursorParking(true);
  setCursorWriter((seq) => void base.write(seq));
  const stdout = wrapStdout(base, {
    sync: true,
    getCursor: getCursorTarget,
    onPark: markCursorPainted,
  });
  const stdin = fakeStdin();
  const inst = render(
    React.createElement(InputBox, {
      options,
      onSubmit: () => undefined,
      onCancel: () => undefined,
      cursorTracking: { termRows: ROWS, bottomChromeRows: 2 },
    }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
  );
  return { inst, stdin };
}

describe("multi-line ↑/↓ navigation", () => {
  it("moves the caret between rows, keeping its column, instead of recalling", async () => {
    const writes: string[] = [];
    const { inst, stdin } = mountInputBox(writes, { width: COLUMNS });

    try {
      // "ab\ncd" → display lines "ab" / "cd", caret parked after "cd".
      stdin.write("ab\ncd");
      await tick();
      // Row 1 (last line): base row 20, col = pad(2) + prompt(0) + col 2 = 4.
      expect(getCursorTarget()).toEqual({ row: 20, col: 4 });

      // ↑ moves up a row to "ab" end; no history recall happens.
      stdin.write("\x1b[A");
      await tick();
      expect(getCursorTarget()).toEqual({ row: 19, col: 6 });

      // The caret is now on the first row; a further ↑ has no row to move to and
      // no history wired, so recall is a no-op and the caret stays put.
      stdin.write("\x1b[A");
      await tick();
      expect(getCursorTarget()).toEqual({ row: 19, col: 6 });

      // ↓ moves back down a row.
      stdin.write("\x1b[B");
      await tick();
      expect(getCursorTarget()).toEqual({ row: 20, col: 4 });
    } finally {
      inst.unmount();
    }
  });

  it("recalls history on ↑ at the first row and restores the draft on ↓ at the last", async () => {
    const writes: string[] = [];
    const { inst, stdin } = mountInputBox(writes, {
      width: COLUMNS,
      history: ["first", "second"],
    });

    try {
      // A two-line draft the user has in progress before recalling history.
      stdin.write("draft\nline");
      await tick();
      // ↑ from the last row moves up a row (draft still intact).
      stdin.write("\x1b[A");
      await tick();
      expect(getCursorTarget()).toEqual({ row: 19, col: 8 });

      // Now on the first row; ↑ falls through to history recall.
      writes.length = 0;
      stdin.write("\x1b[A");
      await tick();
      // Recall drops history[1] ("second") into the buffer; the draft is saved.
      expect(stripAnsi(writes.join(""))).toContain("second");
      expect(getCursorTarget()).toEqual({ row: 20, col: 10 });

      // On the single-line recalled entry, ↓ walks back to the newest and
      // restores the saved multi-line draft. The caret lands back on the last
      // row ("line" end) — ink may skip the byte-identical-diff frame here, so
      // assert on the caret target rather than the (possibly absent) frame.
      stdin.write("\x1b[B");
      await tick();
      expect(getCursorTarget()).toEqual({ row: 20, col: 6 });

      // A further ↑ on the restored multi-line draft moves up a row and forces a
      // rewritten frame, which lets us confirm the draft text came back.
      writes.length = 0;
      stdin.write("\x1b[A");
      await tick();
      expect(stripAnsi(writes.join(""))).toContain("draft");
      expect(stripAnsi(writes.join(""))).not.toContain("second");
    } finally {
      inst.unmount();
    }
  });
});
