/**
 * stdout wrapper for the interactive Ink render that layers two terminal-level
 * behaviors onto every frame Ink writes: Synchronized Output (atomic repaint)
 * and real-cursor parking (so the terminal cursor — and IME popups anchored to
 * it — follow the InputBox caret).
 *
 * ## Synchronized Output (DEC private mode 2026)
 *
 * Ink repaints by erasing the previous frame's lines and writing the new ones
 * (log-update style). The erase→redraw is not atomic, so a viewer can catch the
 * half-cleared intermediate state — the flicker users see during fast streaming,
 * worst when the transcript fills the screen. `BSU` (`CSI ? 2026 h`) tells the
 * terminal to buffer until `ESU` (`CSI ? 2026 l`), then present atomically.
 * Terminals that don't implement 2026 ignore it (unknown DEC private modes are
 * no-ops), so it's safe to emit broadly.
 *
 * ## Real-cursor parking (the tricky part)
 *
 * Ink hides the real cursor and draws no caret of its own; the InputBox fakes a
 * caret with an inverse cell. The real cursor matters anyway: terminals anchor
 * IME composition popups (Chinese / Japanese / …) to it, so it must sit on the
 * caret, not at home (row 1, col 1) where Ink leaves it.
 *
 * We can't just move it after a frame: Ink's next frame runs
 * `eraseLines(prevLineCount)` from wherever the cursor is, assuming it's still
 * at the *end* of the previous frame. Move it away and the next erase corrupts
 * the screen. So each frame is bracketed with DECSC/DECRC (`ESC 7` / `ESC 8`):
 *
 *   ESC8  restore the cursor to Ink's end-of-frame position (saved last frame)
 *   …     Ink's own erase + frame content runs from there, accounting intact
 *   ESC7  save Ink's new end-of-frame position for next frame's restore
 *   move  position the real cursor on the caret (+ show), or hide it if none
 *
 * The save/restore runs every frame so the saved slot never goes stale. On the
 * first frame ESC8 (nothing saved yet) restores to home, which is exactly where
 * Ink's first frame starts on the freshly-homed alt-screen — so it lines up.
 */

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const SAVE = "\x1b7"; // DECSC: save cursor position (+ attrs)
const RESTORE = "\x1b8"; // DECRC: restore cursor position (+ attrs)
const SHOW = "\x1b[?25h";
const HIDE = "\x1b[?25l";

export interface WrapStdoutOptions {
  /** Bracket each frame in Synchronized Output (DEC 2026). */
  sync: boolean;
  /**
   * Park the real cursor on the InputBox caret after each frame. Returns the
   * absolute 1-indexed target, or null to hide the cursor (no active caret).
   * Omit to leave the cursor entirely to Ink (no DECSC/DECRC bracketing).
   */
  getCursor?: () => { row: number; col: number } | null;
}

/**
 * Return a WriteStream proxy that rewrites each string frame Ink emits per
 * {@link WrapStdoutOptions}. Non-string chunks (Buffers) pass through untouched
 * — Ink writes frames as strings, so this never risks splitting a multi-byte
 * sequence. Every other property/method forwards to the underlying stream, so
 * Ink still reads `columns`/`rows`, subscribes to `resize`, and sees `isTTY`.
 */
export function wrapStdout(
  stream: NodeJS.WriteStream,
  opts: WrapStdoutOptions,
): NodeJS.WriteStream {
  const transform = (frame: string): string => {
    const target = opts.getCursor?.() ?? null;
    const track = opts.getCursor !== undefined;
    let out = "";
    if (opts.sync) out += BSU;
    // Restore the cursor to where Ink expects it (its previous end-of-frame
    // position) before Ink's erase runs; skip when not tracking so Ink's
    // natural cursor flow is untouched.
    if (track) out += RESTORE;
    out += frame;
    if (track) {
      out += SAVE; // remember Ink's new end-of-frame position for next restore
      out += target ? `\x1b[${target.row};${target.col}H${SHOW}` : HIDE;
    }
    if (opts.sync) out += ESU;
    return out;
  };
  return new Proxy(stream, {
    get(t, prop, receiver) {
      if (prop === "write") {
        // Bind to the real stream: Node's Writable.write reads `this._writableState`,
        // so an unbound call (`this === undefined` under ESM strict mode) throws.
        const w = (t.write as (...args: unknown[]) => boolean).bind(t);
        return (chunk: unknown, ...rest: unknown[]): boolean => {
          if (typeof chunk === "string" && chunk.length > 0) {
            return w(transform(chunk), ...rest);
          }
          return w(chunk, ...rest);
        };
      }
      const value = Reflect.get(t, prop, receiver);
      // Bind methods to the real stream so `this` isn't the Proxy (Node's
      // stream internals assume the concrete instance).
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}
