/**
 * Bridge between the Screen-level mouse handlers (outside React) and the
 * "Jump to bottom" hint rendered above the InputBox. Mirrors `input-mouse.ts`:
 * the hint registers its absolute screen position while visible, and `screen.ts`
 * consults it to decide whether a hover/click lands on the button.
 *
 * A plain module singleton (like `cursor-target.ts` / `input-mouse.ts`) avoids a
 * store round-trip for the geometry — only the hover *highlight* needs a
 * re-render, and that lives in the store as `jumpButtonHovered`.
 */
export interface JumpButtonBounds {
  /** 1-indexed terminal row the button occupies. */
  row: number;
  /** 1-indexed inclusive column span of the button text. */
  colStart: number;
  colEnd: number;
}

let bounds: JumpButtonBounds | null = null;

export function setJumpButtonBounds(next: JumpButtonBounds | null): void {
  bounds = next;
}

/** True when absolute 1-indexed `(row, col)` falls on the registered button. */
export function hitTestJumpButton(row: number, col: number): boolean {
  return (
    bounds !== null &&
    row === bounds.row &&
    col >= bounds.colStart &&
    col <= bounds.colEnd
  );
}
