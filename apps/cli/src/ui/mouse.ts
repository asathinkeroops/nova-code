import { PassThrough } from "node:stream";

/**
 * xterm SGR mouse-mode wiring. Enables wheel + button event reporting and
 * produces a stdin proxy that Ink reads from. Mouse escape sequences are
 * intercepted (wheel → scroll, button drag → text-selection copy); every
 * other byte passes through unchanged.
 *
 * Why a proxy stream: if we shared `process.stdin` with Ink, the same bytes
 * would reach Ink's keypress parser and surface as garbage text in the input
 * box (e.g. `[<64;78;51M`). The proxy lets Ink see only keyboard events.
 *
 * Trade-off: with mouse mode on, terminals route wheel + click events to us
 * instead of letting the native scrollback / selection handle them. We
 * re-implement selection in app (drag → copy via OSC 52). Most terminals
 * still let users hold Shift to bypass and use native selection.
 */

// `?1002h` = button-event tracking (motion only while a button is held, which
// is what we need for drag selection without spamming motion events when no
// button is pressed). `?1006h` = SGR coordinate format (no col/row overflow
// past 223).
const ENABLE = "\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1002l";

const WHEEL_LINES = 3;

export interface WheelEvent {
  /** Negative = up (content moves down), positive = down (content moves up). */
  delta: number;
}

export interface MousePos {
  /** 1-indexed terminal row. */
  row: number;
  /** 1-indexed terminal column. */
  col: number;
}

export interface MouseHandlers {
  onWheel: (event: WheelEvent) => void;
  /** Button-1 press — opens a fresh selection at `start`. */
  onSelectStart: (pos: MousePos) => void;
  /** Motion while button-1 is held — updates the selection's end point. */
  onSelectUpdate: (pos: MousePos) => void;
  /** Button-1 release — finalises and clears the selection. `moved` is true
   *  iff the cursor moved between press and release (i.e. real drag, not click). */
  onSelectEnd: (pos: MousePos, moved: boolean) => void;
}

export interface FilteredStdin {
  /** Ink-ready stdin. Pass to `render(tree, { stdin })`. */
  stream: NodeJS.ReadStream;
  /** Tear down: detach listener, restore terminal, end the proxy stream. */
  detach: () => void;
}

// SGR mouse sequence: `\x1b[<<btn>;<col>;<row>(M|m)`. Capture all four pieces.
// eslint-disable-next-line no-control-regex
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// Could the buffer's tail be the start of an incomplete mouse sequence?
// Recognises every prefix from `\x1b[<` up to (but not including) the final
// M/m terminator. Importantly this does NOT match a bare `\x1b` or `\x1b[`:
// holding those back would swallow the user's Esc keypress (and any other
// CSI-prefixed key like arrows) because the terminal sends Esc as a lone
// `\x1b` byte with no follow-up. Ink has its own short timeout to
// disambiguate Esc from CSI sequences, so passing those bytes through
// immediately is correct.
// eslint-disable-next-line no-control-regex
const PARTIAL_MOUSE_RE = /\x1b\[<(?:\d+(?:;\d+){0,2}(?:;\d*)?)?$/;

/**
 * Wire mouse reporting and return a stdin proxy. Caller owns `detach`.
 * No-op (returns `process.stdin` and a noop detach) when stdout is not a TTY.
 */
export function attachFilteredStdin(handlers: MouseHandlers): FilteredStdin {
  if (!process.stdout.isTTY) {
    return { stream: process.stdin, detach: () => undefined };
  }

  process.stdout.write(ENABLE);

  const proxy = new PassThrough();
  // Make Ink treat the proxy as a real TTY. `setRawMode` / `ref` / `unref`
  // forward to the real stdin so terminal state and the libuv event-loop
  // refcount stay correct (Ink toggles them in its useInput hook).
  Object.defineProperties(proxy, {
    isTTY: { value: true, configurable: true },
    setRawMode: {
      value: (mode: boolean): NodeJS.ReadStream => {
        if (process.stdin.isTTY) process.stdin.setRawMode(mode);
        return proxy as unknown as NodeJS.ReadStream;
      },
      configurable: true,
    },
    ref: {
      value: (): NodeJS.ReadStream => {
        process.stdin.ref();
        return proxy as unknown as NodeJS.ReadStream;
      },
      configurable: true,
    },
    unref: {
      value: (): NodeJS.ReadStream => {
        process.stdin.unref();
        return proxy as unknown as NodeJS.ReadStream;
      },
      configurable: true,
    },
  });

  // Selection state for button-1. Captured on press, updated on motion,
  // finalised on release. Null when no drag is in flight.
  let dragStart: MousePos | null = null;
  let dragLast: MousePos | null = null;

  let pending = "";
  const onData = (chunk: Buffer | string): void => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    pending += s;

    let lastEnd = 0;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    MOUSE_RE.lastIndex = 0;
    while ((m = MOUSE_RE.exec(pending)) !== null) {
      if (m.index > lastEnd) out.push(pending.slice(lastEnd, m.index));
      const btn = Number.parseInt(m[1] ?? "0", 10);
      const col = Number.parseInt(m[2] ?? "0", 10);
      const row = Number.parseInt(m[3] ?? "0", 10);
      const press = m[4] === "M";
      // Mask out modifier bits (shift=4, alt=8, ctrl=16) before checking.
      const code = btn & ~0b11100;

      if (code === 64 && press) {
        handlers.onWheel({ delta: -WHEEL_LINES });
      } else if (code === 65 && press) {
        handlers.onWheel({ delta: WHEEL_LINES });
      } else if (code === 0 && press) {
        // Button-1 press → start selection.
        dragStart = { row, col };
        dragLast = { row, col };
        handlers.onSelectStart({ row, col });
      } else if (code === 32 && press && dragStart) {
        // Motion while button-1 held (`?1002h` reports as button 32 + motion).
        // Skip events that don't actually move the pointer to keep selection
        // updates cheap (terminals can report repeats on cell-boundary jitter).
        if (!dragLast || dragLast.row !== row || dragLast.col !== col) {
          dragLast = { row, col };
          handlers.onSelectUpdate({ row, col });
        }
      } else if (!press && dragStart) {
        // Any button release while we're tracking a drag → finalize + clear.
        const end = dragLast ?? { row, col };
        const moved = end.row !== dragStart.row || end.col !== dragStart.col;
        handlers.onSelectEnd(end, moved);
        dragStart = null;
        dragLast = null;
      }
      lastEnd = MOUSE_RE.lastIndex;
    }

    const tail = pending.slice(lastEnd);
    if (PARTIAL_MOUSE_RE.test(tail)) {
      // Hold the partial fragment until the rest arrives. Cap to keep a
      // pathological stream of `\x1b[<...` from growing without bound.
      pending = tail.length > 128 ? tail.slice(-128) : tail;
    } else {
      out.push(tail);
      pending = "";
    }

    const joined = out.join("");
    if (joined.length > 0) proxy.write(joined);
  };

  process.stdin.on("data", onData);
  // Ensure we actually receive data; raw mode is owned by Ink via the
  // setRawMode proxy above (it flips it on after we return).
  if (process.stdin.isPaused()) process.stdin.resume();

  // Safety net: if the process exits without going through our `detach`
  // (uncaught error, SIGINT, etc.), the terminal would be left in mouse mode
  // and every subsequent mouse move would bleed `\x1b[<…M` garbage into the
  // user's next prompt. Register on `exit` so it runs even on hard exits.
  let detached = false;
  const safetyDisable = (): void => {
    if (detached) return;
    detached = true;
    try {
      process.stdout.write(DISABLE);
    } catch {
      // ignore
    }
  };
  process.once("exit", safetyDisable);

  const detach = (): void => {
    process.stdin.off("data", onData);
    process.off("exit", safetyDisable);
    safetyDisable();
    proxy.end();
  };

  return { stream: proxy as unknown as NodeJS.ReadStream, detach };
}
