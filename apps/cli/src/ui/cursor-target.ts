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
 */
let target: { row: number; col: number } | null = null;

export function setCursorTarget(next: { row: number; col: number } | null): void {
  target = next;
}

export function getCursorTarget(): { row: number; col: number } | null {
  return target;
}
