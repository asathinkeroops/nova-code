import { visibleWidth } from "./width.js";

/** `49h48m42s`, dropping leading units that are zero. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

/** Compact token magnitude: 1_500_000 → "1.5M", 1_234 → "1.2K", 512 → "512". */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${Number.isInteger(k) ? k : Number(k.toFixed(1))}K`;
  }
  return `${Math.max(0, Math.floor(tokens))}`;
}

/** A `width`-cell meter, e.g. 9% over 10 cells → "░░░░░░░░░░". */
export function contextBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.floor((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/** Replace a leading `home` path with `~`. */
export function displayCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

export interface StatusSegment {
  /** Leading glyph, rendered in `color`. */
  icon: string;
  /** Value text, rendered dim. */
  text: string;
  /** Ink color name for the icon. */
  color?: string;
}

/**
 * Greedily keep leading segments that fit within `maxWidth` display cells once
 * joined by `sep`. Segments are listed left-to-right in priority order, so a
 * narrow terminal drops the rightmost (least important) ones first.
 */
export function fitSegments(
  segments: StatusSegment[],
  maxWidth: number,
  sep = " | ",
): StatusSegment[] {
  const sepW = visibleWidth(sep);
  const out: StatusSegment[] = [];
  let used = 0;
  for (const seg of segments) {
    const segW = visibleWidth(`${seg.icon} ${seg.text}`);
    const add = out.length === 0 ? segW : sepW + segW;
    if (used + add > maxWidth) break;
    used += add;
    out.push(seg);
  }
  return out;
}
