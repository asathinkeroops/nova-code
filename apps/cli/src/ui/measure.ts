import wrapAnsi from "wrap-ansi";
import type { RenderItem } from "./render-item.js";
import { clickTargetLine, renderItemToString } from "./render-strings.js";

interface CacheEntry {
  width: number;
  lines: string[];
  /**
   * Cached {@link clickTargetLine}, filled on first use. `undefined` means "not
   * computed yet" — `null` is a real answer (the item has no control row), and
   * only visible items are ever asked, so this stays lazy.
   */
  target?: number | null;
}

/**
 * Global per-item line cache. Keyed by `RenderItem` identity — `buildRenderItems`
 * interns items, returning the same reference whenever nothing an item renders
 * from has changed, so cache hits are the norm across re-renders. On `/clear` /
 * `/resume` the whole RenderItem tree is dropped and the WeakMap GCs naturally.
 */
const cache = new WeakMap<RenderItem, CacheEntry>();

/** The cache entry for `item` at `width`, measuring it if needed. */
function entryFor(item: RenderItem, width: number): CacheEntry {
  const hit = cache.get(item);
  if (hit && hit.width === width) return hit;
  const entry: CacheEntry = { width, lines: wrapToLines(renderItemToString(item, width), width) };
  cache.set(item, entry);
  return entry;
}

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
  return entryFor(item, width).lines;
}

/**
 * Index of `item`'s click/hover control row, cached alongside its lines.
 *
 * Uncached this was a per-frame cost, not a per-item one: `sliceLines` asks for
 * every visible item on every render, and for a body-bearing tool call the answer
 * is derived by re-rendering the whole diff. It shares the line cache's width key
 * because it depends on exactly the same inputs.
 */
export function itemTargetLine(item: RenderItem, width: number): number | null {
  const entry = entryFor(item, width);
  if (entry.target === undefined) entry.target = clickTargetLine(item, width);
  return entry.target;
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
  /**
   * Per-visible-line click/hover target, aligned 1:1 with {@link lines}. Holds a
   * collapsible item's key on its control row (tool-batch title / thinking
   * "… +N lines" hint) and `null` everywhere else, so the mouse layer can map a
   * terminal row back to that item without re-measuring.
   */
  targets: Array<string | null>;
  /** True total line count of the input items at this width. */
  totalLines: number;
  /** Lines hidden above the slice (in [0, totalLines]). */
  hiddenAbove: number;
  /** Lines hidden below the slice (in [0, totalLines]). */
  hiddenBelow: number;
}

/**
 * Return the last `n` visual lines of `items` at the given width.
 * Convenience wrapper over `sliceLines`; O(items) + O(n) with cache.
 */
export function tailLines(items: RenderItem[], width: number, n: number): string[] {
  if (n <= 0 || items.length === 0) return [];
  return sliceLines(items, width, Number.MAX_SAFE_INTEGER, n).lines;
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
    return { lines: [], targets: [], totalLines: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }
  const total = totalHeight(items, width);
  const maxOffset = Math.max(0, total - viewportRows);
  const off = Math.max(0, Math.min(offset, maxOffset));
  const end = off + viewportRows;

  const collected: string[] = [];
  const targets: Array<string | null> = [];
  let scanned = 0;
  outer: for (const it of items) {
    const itemLines = measureItem(it, width);
    if (scanned + itemLines.length <= off) {
      scanned += itemLines.length;
      continue;
    }
    // Collapsible items (tool batch, committed thinking) expose one clickable
    // control row; tag that row with the item key so the mouse layer can resolve
    // a viewport row to the item. Only the control row itself is tagged, and
    // only while it is visible (a scrolled-off control can't be clicked).
    const targetLine = itemTargetLine(it, width);
    const key = targetLine !== null ? it.key : null;
    for (let li = 0; li < itemLines.length; li++) {
      if (scanned >= off && scanned < end) {
        collected.push(itemLines[li] ?? "");
        targets.push(key !== null && li === targetLine ? key : null);
      }
      scanned++;
      if (scanned >= end) break outer;
    }
  }

  return {
    lines: collected,
    targets,
    totalLines: total,
    hiddenAbove: off,
    hiddenBelow: Math.max(0, total - off - collected.length),
  };
}
