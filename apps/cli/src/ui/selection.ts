import { charDisplayWidth, stripAnsi } from "./width.js";

/**
 * Slice an ANSI line by visual column range. Returns the visible characters
 * in `[startCol, endCol)`, with ANSI escape sequences stripped — we only
 * need the plain text for clipboard.
 *
 * Columns are 0-indexed visual positions. Wide characters (CJK, emoji) count
 * for 2 columns; an end that lands mid-wide-char includes the whole char.
 */
export function sliceVisualCols(line: string, startCol: number, endCol: number): string {
  if (startCol >= endCol) return "";
  const plain = stripAnsi(line);
  let col = 0;
  let out = "";
  for (let i = 0; i < plain.length; i++) {
    if (col >= endCol) break;
    const w = charDisplayWidth(plain, i);
    if (col + w > startCol) {
      out += plain[i];
    }
    col += w;
  }
  return out;
}

export interface DragRect {
  startRow: number; // 0-indexed
  startCol: number; // 0-indexed
  endRow: number;
  endCol: number;
}

/**
 * Normalise a drag's start/end into a top-to-bottom, left-to-right rectangle.
 * Handles all four drag directions transparently.
 */
export function normalizeDrag(rect: DragRect): DragRect {
  let { startRow, startCol, endRow, endCol } = rect;
  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    [startRow, endRow] = [endRow, startRow];
    [startCol, endCol] = [endCol, startCol];
  }
  return { startRow, startCol, endRow, endCol };
}

/**
 * Stream-style extraction: lines between the two endpoints are read as a
 * continuous text flow (line boundaries → `\n`). Matches how most editors
 * handle multi-line selection — easier to reason about than a block rect.
 */
// Claude Code-style selection: a muted steel-blue background that lets the
// existing foreground colors read through. Picked to match the TUI's
// "translucent" feel — dark enough for white/syntax text, blue enough to
// clearly read as a selection.
const SEL_BG_OPEN = "\x1b[48;2;45;80;130m";
const SEL_BG_CLOSE = "\x1b[49m";

/**
 * Wrap the visible chars in `[startCol, endCol)` of an ANSI line with a
 * selection background so the user sees what they're selecting. Pre-existing
 * SGR codes inside the range are preserved; the background is re-emitted
 * after each embedded SGR so an inline reset (e.g. `\x1b[0m`) doesn't punch a
 * hole through the highlight.
 */
export function applyInverse(line: string, startCol: number, endCol: number): string {
  if (startCol >= endCol || line.length === 0) return line;
  let col = 0;
  let out = "";
  let inSel = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end !== -1) {
        out += line.slice(i, end + 1);
        if (inSel) out += SEL_BG_OPEN;
        i = end + 1;
        continue;
      }
    }
    if (!inSel && col >= startCol && col < endCol) {
      out += SEL_BG_OPEN;
      inSel = true;
    }
    if (inSel && col >= endCol) {
      out += SEL_BG_CLOSE;
      inSel = false;
    }
    out += ch;
    col += charDisplayWidth(line, i);
    i++;
  }
  if (inSel) out += SEL_BG_CLOSE;
  return out;
}

export function extractSelection(
  lines: ReadonlyArray<string>,
  rect: DragRect,
): string {
  const { startRow, startCol, endRow, endCol } = normalizeDrag(rect);
  const out: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const line = lines[r];
    if (line === undefined) continue;
    const lo = r === startRow ? startCol : 0;
    const hi = r === endRow ? endCol : Number.MAX_SAFE_INTEGER;
    out.push(sliceVisualCols(line, lo, hi));
  }
  return out.join("\n").replace(/[ \t]+$/gm, ""); // trim trailing whitespace per line
}

/**
 * Return a copy of `lines` with the selection rect painted in inverse video.
 * Lines outside the selection are returned unchanged (same references), so
 * the caller can pass the result straight to a Text node without bloating
 * memory for typical short selections.
 */
export function highlightLines(
  lines: ReadonlyArray<string>,
  rect: DragRect,
): string[] {
  const { startRow, startCol, endRow, endCol } = normalizeDrag(rect);
  const out: string[] = [];
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r] ?? "";
    if (r < startRow || r > endRow) {
      out.push(line);
      continue;
    }
    const lo = r === startRow ? startCol : 0;
    const hi = r === endRow ? endCol : Number.MAX_SAFE_INTEGER;
    out.push(applyInverse(line, lo, hi));
  }
  return out;
}
