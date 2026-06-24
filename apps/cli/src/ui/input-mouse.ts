/**
 * Bridge between the Screen-level mouse handlers (outside React) and the
 * permanent InputBox component. The mouse proxy in `mouse.ts` reports presses,
 * drags and releases in absolute terminal coordinates; `screen.ts` consults the
 * registered controller to decide whether a gesture lands on the input box (vs.
 * the viewport) and, if so, to move the caret or drive a text selection.
 *
 * A plain module singleton — like `cursor-target.ts` — avoids a store round-trip
 * that would lag the caret/selection a frame behind the pointer. Only the
 * permanent, bottom-pinned InputBox registers a controller; it clears it when a
 * modal takes over input (so a click never moves a caret the user can't see).
 */
export interface InputMouseController {
  /**
   * Map an absolute 1-indexed terminal `(row, col)` to a buffer offset, or null
   * when the point isn't on one of the input's body lines (so the gesture should
   * fall through to the viewport). Mirrors the caret row/col math so a click
   * lands exactly where the caret would render.
   */
  hitTest(row: number, col: number): number | null;
  /** Move the caret to a buffer offset (single click). Clears any selection. */
  moveCaret(offset: number): void;
  /** Set or clear the active selection by buffer offsets (drag). */
  setRange(range: { anchor: number; head: number } | null): void;
  /** The buffer text between offsets `[lo, hi)`, for copy on release. */
  textBetween(lo: number, hi: number): string;
}

let controller: InputMouseController | null = null;

export function setInputMouseController(next: InputMouseController | null): void {
  controller = next;
}

export function getInputMouseController(): InputMouseController | null {
  return controller;
}
