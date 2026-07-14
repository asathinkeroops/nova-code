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

// `?1003h` = any-event tracking: report motion with OR without a button held.
// We need the button-held motion for drag selection and the no-button motion
// for hover (highlighting a collapsible tool-batch title under the pointer).
// `?1006h` = SGR coordinate format (no col/row overflow past 223). `?2004h` =
// bracketed paste, so the terminal wraps a paste in `\x1b[200~ … \x1b[201~` —
// letting us tell a paste from typing and detect an empty (non-text, e.g.
// image) paste.
const ENABLE = "\x1b[?1003h\x1b[?1006h\x1b[?2004h";
const DISABLE = "\x1b[?2004l\x1b[?1006l\x1b[?1003l";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// A paste with no text content is a non-text clipboard item (most commonly an
// image): synthesize Ctrl+V so the InputBox's existing paste handler reads the
// clipboard and attaches the image. `\x16` is the byte Ink decodes as Ctrl+V.
const SYNTHETIC_CTRL_V = "\x16";

/**
 * Length of the longest suffix of `s` that is a proper prefix of `marker`, so a
 * marker split across stdin chunks can be held back instead of leaking as text.
 */
function partialPrefixLen(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

/**
 * A stateful bracketed-paste resolver. Feed it raw stdin chunks; it returns the
 * stream with paste markers stripped, where a text paste becomes its inner text
 * and an *empty* paste (a non-text clipboard item, e.g. an image) becomes a
 * synthetic Ctrl+V so the InputBox's paste handler reads the clipboard. State is
 * carried across chunks, so markers and bodies split over reads resolve cleanly.
 */
export function createPasteResolver(): (raw: string) => string {
  let scan = ""; // bytes not yet resolved (a possibly-incomplete marker)
  let body = ""; // inner text of the paste currently being collected
  let inPaste = false;
  return (raw: string): string => {
    scan += raw;
    let out = "";
    for (;;) {
      if (!inPaste) {
        const i = scan.indexOf(PASTE_START);
        if (i === -1) {
          // Flush all but a trailing fragment that could begin a start marker
          // arriving in the next chunk.
          const hold = partialPrefixLen(scan, PASTE_START);
          out += scan.slice(0, scan.length - hold);
          scan = scan.slice(scan.length - hold);
          return out;
        }
        out += scan.slice(0, i);
        scan = scan.slice(i + PASTE_START.length);
        inPaste = true;
      } else {
        const j = scan.indexOf(PASTE_END);
        if (j === -1) {
          const hold = partialPrefixLen(scan, PASTE_END);
          body += scan.slice(0, scan.length - hold);
          scan = scan.slice(scan.length - hold);
          return out;
        }
        body += scan.slice(0, j);
        scan = scan.slice(j + PASTE_END.length);
        inPaste = false;
        out += body.length > 0 ? body : SYNTHETIC_CTRL_V;
        body = "";
      }
    }
  };
}

const WHEEL_LINES = 3;

// Momentum smoothing. macOS trackpads turn a single flick into a burst of dozens
// of wheel events over ~200ms; the terminal forwards every one, and applying
// each ×WHEEL_LINES instantly sends the viewport flying in one jarring jump.
// Rather than DROP the burst (which kills the sense of inertia entirely), we
// accumulate it and release it over several frames with deceleration: each frame
// emits a *fraction* of what's left (capped and floored), so a fling scrolls fast
// then eases out — real momentum, just controllable. A gentle per-frame decay
// bleeds off a hard fling so it can't ride for a full second (bounds overshoot
// without flattening the curve). The first notch after an idle gap is emitted
// synchronously so ordinary single-notch scrolling still feels instant.
const WHEEL_FLUSH_MS = 16; // ~1 frame; the release fraction (not this) sets the feel
const WHEEL_RELEASE_FRACTION = 0.3; // portion of remaining burst released per frame
const WHEEL_MIN_STEP = WHEEL_LINES; // never crawl slower than a single notch
const WHEEL_MAX_STEP = 9; // cap peak speed so the first frame isn't a huge jump
const WHEEL_DECAY = 0.85; // <1 sheds a little leftover each frame to curb overshoot
// Hard ceiling on accumulated momentum: no matter how hard the fling, a single
// gesture never has more than this many lines queued to scroll. This is the
// primary "how far can one flick travel" knob — decay only shapes the ease-out.
const WHEEL_MAX_PENDING = 24;

export interface WheelThrottleOptions {
  /** Delay between released frames, ms. */
  intervalMs: number;
  /** Fraction of the remaining accumulated delta released each frame (0–1). */
  releaseFraction: number;
  /** Floor on a frame's magnitude so the tail doesn't crawl. */
  minStep: number;
  /** Cap on a frame's magnitude so the first frame isn't a giant jump. */
  maxStep: number;
  /** Leftover retained after each frame (<1 sheds momentum to bound overshoot). */
  decay: number;
  /** Hard ceiling on |accumulated delta|; caps how far one fling can travel. */
  maxPending: number;
}

export interface WheelThrottle {
  /** Feed a raw wheel delta (already in lines). */
  push: (delta: number) => void;
  /** Cancel any scheduled flush and drop pending delta. */
  dispose: () => void;
}

/**
 * Decelerating release throttle for wheel deltas. The first delta after an idle
 * gap is emitted synchronously (instant response for a lone notch); a sustained
 * burst accumulates and drains over successive frames, each releasing a fraction
 * of what remains (floored to `minStep`, capped to `maxStep`) with an optional
 * `decay` on the leftover — so momentum eases out instead of either jumping all
 * at once or vanishing. Pure w.r.t. `emit` + timers so it can be unit-tested with
 * fake timers. `setTimeoutFn`/`clearTimeoutFn` are injectable for tests; they
 * default to the globals.
 */
export function createWheelThrottle(
  emit: (delta: number) => void,
  opts: WheelThrottleOptions,
  setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void = clearTimeout,
): WheelThrottle {
  const { intervalMs, releaseFraction, minStep, maxStep, decay, maxPending } = opts;
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (pending === 0) {
      timer = null; // idle: stop the timer so we don't ref the event loop
      return;
    }
    const sign = pending < 0 ? -1 : 1;
    const mag = Math.abs(pending);
    // Decelerating step: a fraction of what's left, but never below one notch
    // (so the tail doesn't crawl) nor above the peak cap (so no giant jump), and
    // never more than actually remains.
    const stepMag = Math.min(mag, maxStep, Math.max(minStep, Math.ceil(mag * releaseFraction)));
    const step = sign * stepMag;
    pending -= step;
    // Shed a little of the leftover so a very hard fling can't ride forever.
    if (decay < 1) pending = Math.trunc(pending * decay);
    emit(step);
    timer = setTimeoutFn(flush, intervalMs); // keep draining until pending hits 0
  };

  return {
    push: (delta: number): void => {
      if (delta === 0) return;
      // Clamp accumulated momentum to the ceiling so a hard fling can't queue an
      // unbounded scroll — this is what stops it flying off the deep end.
      pending = Math.max(-maxPending, Math.min(pending + delta, maxPending));
      if (timer === null) {
        // Leading edge: respond to the first notch instantly, then start the
        // drain loop. `flush` emits the just-accumulated delta and arms the
        // timer, so a lone notch scrolls immediately with no perceptible lag.
        flush();
      }
    },
    dispose: (): void => {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      pending = 0;
    },
  };
}

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
  /** Pointer motion with no button held — drives hover highlight. Fires only
   *  when the pointer changes terminal cell. */
  onHover: (pos: MousePos) => void;
  /** End / ctrl+End — jump the transcript to the bottom. Ink zeroes the `input`
   *  for named keys like End, so we intercept the raw sequence here instead. */
  onJumpToBottom: () => void;
}

// End / ctrl+End escape sequences. Ink's `useInput` maps these to `name: 'end'`
// and blanks out `input` (End is in its `nonAlphanumericKeys`), so a React-level
// handler can't see them — we catch the raw bytes before they reach Ink.
const JUMP_TO_BOTTOM_SEQS = [
  "\x1b[1;5F", // ctrl+End
  "\x1b[F", // End (xterm)
  "\x1bOF", // End (application cursor mode)
  "\x1b[4~", // End (vt220)
];

/**
 * Strip any End / ctrl+End sequences from a keyboard byte-run, returning the
 * remaining text and whether a jump key was present. Pure so it can be unit-
 * tested; `onData` calls it on the non-mouse, non-paste residue before forwarding
 * to Ink.
 */
export function extractJumpToBottom(text: string): { rest: string; jumped: boolean } {
  let rest = text;
  let jumped = false;
  for (const seq of JUMP_TO_BOTTOM_SEQS) {
    if (rest.includes(seq)) {
      rest = rest.split(seq).join("");
      jumped = true;
    }
  }
  return { rest, jumped };
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
  // Last cell a no-button hover fired for, so we emit one event per cell change
  // (not per duplicate motion report) under any-event tracking.
  let hoverLast: MousePos | null = null;

  // Smooth wheel bursts (trackpad momentum) into a decelerating scroll before
  // they reach the store, instead of applying every raw event instantly.
  const wheel = createWheelThrottle((delta) => handlers.onWheel({ delta }), {
    intervalMs: WHEEL_FLUSH_MS,
    releaseFraction: WHEEL_RELEASE_FRACTION,
    minStep: WHEEL_MIN_STEP,
    maxStep: WHEEL_MAX_STEP,
    decay: WHEEL_DECAY,
    maxPending: WHEEL_MAX_PENDING,
  });

  const resolvePastes = createPasteResolver();

  let pending = "";
  const onData = (chunk: Buffer | string): void => {
    const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const s = resolvePastes(raw);
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
        wheel.push(-WHEEL_LINES);
      } else if (code === 65 && press) {
        wheel.push(WHEEL_LINES);
      } else if (code === 0 && press) {
        // Button-1 press → start selection.
        dragStart = { row, col };
        dragLast = { row, col };
        handlers.onSelectStart({ row, col });
      } else if (code === 32 && press && dragStart) {
        // Motion while button-1 held (reported as button 32 + motion). Skip
        // events that don't actually move the pointer to keep selection updates
        // cheap (terminals can report repeats on cell-boundary jitter).
        if (!dragLast || dragLast.row !== row || dragLast.col !== col) {
          dragLast = { row, col };
          handlers.onSelectUpdate({ row, col });
        }
      } else if (code === 35 && press && !dragStart) {
        // Motion with no button held (any-event tracking reports button 3 +
        // motion = 35). Drives hover; deduped per cell so we don't fire on every
        // duplicate motion report. Suppressed mid-drag (dragStart set).
        if (!hoverLast || hoverLast.row !== row || hoverLast.col !== col) {
          hoverLast = { row, col };
          handlers.onHover({ row, col });
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

    // Intercept End / ctrl+End before Ink swallows them: strip the sequence from
    // the byte stream and fire the jump handler. (Usually arrives atomically; a
    // sequence split across chunks falls through and is harmless.)
    const { rest, jumped } = extractJumpToBottom(out.join(""));
    if (jumped) handlers.onJumpToBottom();
    if (rest.length > 0) proxy.write(rest);
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
    wheel.dispose();
    safetyDisable();
    proxy.end();
  };

  return { stream: proxy as unknown as NodeJS.ReadStream, detach };
}
