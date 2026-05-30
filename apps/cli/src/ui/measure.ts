import wrapAnsi from "wrap-ansi";
import type { RenderItem } from "./render-item.js";
import { renderItemToString } from "./render-strings.js";

interface CacheEntry {
  width: number;
  lines: string[];
}

/**
 * Global per-item line cache. Keyed by `RenderItem` identity —
 * `buildRenderItems` returns stable references for unchanged inputs, so cache
 * hits are common across re-renders. On `/clear` / `/compact` / `/resume`
 * the whole RenderItem tree is dropped and the WeakMap GCs naturally.
 */
const cache = new WeakMap<RenderItem, CacheEntry>();

/**
 * Hard-wrap an ANSI string to the given column width and return the visual
 * line array. `hard:true` + `wordWrap:false` gives predictable char-level
 * wrapping; `trim:false` preserves leading whitespace (e.g. user bubble
 * padding, code-block gutters).
 */
function wrapToLines(s: string, width: number): string[] {
  if (s.length === 0) return [""];
  const w = Math.max(1, width);
  return wrapAnsi(s, w, { hard: true, wordWrap: false, trim: false }).split("\n");
}

/**
 * Count the visual rows a string occupies when hard-wrapped to `width`,
 * including any embedded newlines. Used to reserve accurate row budgets for
 * in-stream chrome (e.g. picker headers/footers that wrap).
 */
export function countWrappedLines(s: string, width: number): number {
  return wrapToLines(s, width).length;
}

/**
 * Measure one item to its line array at the given width. Cached by item
 * identity; recomputed if the cached entry was for a different width.
 */
export function measureItem(item: RenderItem, width: number): string[] {
  const hit = cache.get(item);
  if (hit && hit.width === width) return hit.lines;
  const lines = wrapToLines(renderItemToString(item, width), width);
  cache.set(item, { width, lines });
  return lines;
}

/**
 * Sum of `measureItem(it, width).length` across all items. O(items) with cache.
 */
export function totalHeight(items: RenderItem[], width: number): number {
  let h = 0;
  for (const it of items) h += measureItem(it, width).length;
  return h;
}

export interface VisibleSlice {
  /** Visible ANSI lines, ready to join with "\n". */
  lines: string[];
  /** True total line count of the input items at this width. */
  totalLines: number;
  /** Lines hidden above the slice (in [0, totalLines]). */
  hiddenAbove: number;
  /** Lines hidden below the slice (in [0, totalLines]). */
  hiddenBelow: number;
}

/**
 * Slice `items` to the visual rows [offset, offset+viewportRows). Clamps
 * `offset` defensively so a stale store value never produces out-of-bounds
 * output. O(items) plus O(viewportRows).
 */
export function sliceLines(
  items: RenderItem[],
  width: number,
  offset: number,
  viewportRows: number,
): VisibleSlice {
  if (viewportRows <= 0) {
    return { lines: [], totalLines: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }
  const total = totalHeight(items, width);
  const maxOffset = Math.max(0, total - viewportRows);
  const off = Math.max(0, Math.min(offset, maxOffset));
  const end = off + viewportRows;

  const collected: string[] = [];
  let scanned = 0;
  outer: for (const it of items) {
    const itemLines = measureItem(it, width);
    if (scanned + itemLines.length <= off) {
      scanned += itemLines.length;
      continue;
    }
    for (const line of itemLines) {
      if (scanned >= off && scanned < end) collected.push(line);
      scanned++;
      if (scanned >= end) break outer;
    }
  }

  return {
    lines: collected,
    totalLines: total,
    hiddenAbove: off,
    hiddenBelow: Math.max(0, total - off - collected.length),
  };
}
