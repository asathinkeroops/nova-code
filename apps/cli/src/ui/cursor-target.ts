/**
 * Where the real terminal cursor should be parked after each Ink frame: the
 * InputBox caret, in absolute 1-indexed terminal coordinates, or null when no
 * text caret is active (a modal owns input, setup wizard, etc.).
 *
 * The InputBox writes this during render (the same render that moves its inverse
 * caret cell), so the value is in place by the time Ink serializes that exact
 * frame; the stdout wrapper (see sync-output.ts) reads it when it writes the
 * frame, keeping the real cursor — and any IME composition popup anchored to it
 * — exactly on the caret. A plain module singleton (not React state) avoids a
 * store round-trip that would lag the cursor a frame behind the caret.
 *
 * Frames are not the only path, though: a caret move that leaves the frame
 * byte-identical (←/→, Ctrl+A/E, a click — with the real caret live the InputBox
 * draws no cursor cell, so nothing in the output depends on the caret offset)
 * makes Ink skip the write altogether, and the cursor would sit stranded at its
 * old column. So this module also parks the cursor out-of-band; see
 * `flushCursor` / `setCursorWriter` below.
 */
export interface CursorPos {
  row: number;
  col: number;
}

let target: CursorPos | null = null;

/**
 * Where the real cursor was last actually *painted*, i.e. the target carried by
 * the most recent frame the stdout wrapper wrote (see `markCursorPainted`), or
 * by an out-of-band park (below). Diverges from `target` exactly when a render
 * moved the caret but Ink emitted no frame for it.
 */
let painted: CursorPos | null = null;

/**
 * Writes a bare escape sequence straight to the *unwrapped* stdout. Installed by
 * `Screen` only while cursor parking is live; null disables out-of-band parking.
 * Must NOT be the wrapped stream — the wrapper treats every string write as an
 * Ink frame and would sandwich it in DECRC/DECSC.
 */
let writer: ((seq: string) => void) | null = null;

let pendingFlush: ReturnType<typeof setImmediate> | null = null;

function samePos(a: CursorPos | null, b: CursorPos | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.row === b.row && a.col === b.col;
}

function moveSequence(pos: CursorPos | null): string {
  return pos ? `\x1b[${pos.row};${pos.col}H\x1b[?25h` : "\x1b[?25l";
}

/**
 * Park the real cursor on `target` without an Ink frame.
 *
 * Ink skips `stdout.write` entirely when a render produces byte-identical output
 * (see `log-update`), and with the real caret live the InputBox draws no cursor
 * cell of its own — so moving the caret (←/→, Ctrl+A/E, a click) changes nothing
 * in the frame and Ink writes nothing, leaving the terminal cursor stranded at
 * its previous column. Emitting the move ourselves is safe because the wrapper
 * re-issues DECRC before every frame: the next frame still starts from Ink's
 * saved end-of-frame position, whatever we did to the cursor in between.
 *
 * Deferred to a macrotask so the common case — a render that *does* change the
 * frame — is absorbed by that frame's own park (which calls `markCursorPainted`)
 * and costs no extra bytes.
 */
function flushCursor(): void {
  pendingFlush = null;
  if (!writer || samePos(target, painted)) return;
  writer(moveSequence(target));
  painted = target;
}

export function setCursorTarget(next: CursorPos | null): void {
  target = next;
  if (!writer || pendingFlush !== null || samePos(target, painted)) return;
  pendingFlush = setImmediate(flushCursor);
}

export function getCursorTarget(): CursorPos | null {
  return target;
}

/**
 * Record that a written frame already parked the real cursor at `pos`, so the
 * pending out-of-band park (if any) becomes a no-op. Wired to the stdout
 * wrapper's `onPark`.
 */
export function markCursorPainted(pos: CursorPos | null): void {
  painted = pos;
}

/**
 * Install (or clear, with null) the raw-stdout writer used for out-of-band
 * parking. Clearing also cancels any scheduled flush, so a torn-down screen
 * never writes to the terminal after the fact.
 */
export function setCursorWriter(next: ((seq: string) => void) | null): void {
  writer = next;
  if (next === null && pendingFlush !== null) {
    clearImmediate(pendingFlush);
    pendingFlush = null;
  }
  painted = null;
}

/**
 * Whether the stdout wrapper is actually parking the real cursor on the target
 * each frame (TTY + `settings.terminal.cursorFollow`). The InputBox reads this
 * to decide whether it still needs its own inverse caret cell: when the real
 * cursor is on the caret, drawing the fake one too leaves the terminal's cursor
 * block sitting on an inverted (white) cell, which shows through as slivers
 * above/below wherever the block is shorter than the character cell. Off — no
 * parking — the fake caret is the only caret there is, so it stays.
 */
let parking = false;

export function setCursorParking(enabled: boolean): void {
  parking = enabled;
}

export function isCursorParking(): boolean {
  return parking;
}
