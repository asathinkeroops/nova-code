import { BASH_HEX } from "../colors.js";
import { t } from "../i18n/index.js";
import { visibleWidth } from "./width.js";
import type { PermissionMode } from "../permissions.js";

/** Dim hint appended after the mode label below the StatusLine.
 * A function (not a const) so it reads the active locale at call time. */
export function permissionModeHint(): string {
  return t.status.modeHint;
}

/** A colored mode label plus the Ink color used to render it. */
export interface PermissionModeIndicator {
  label: string;
  color: string;
}

/**
 * Green label shown below the StatusLine while the input is in shell (`!`)
 * mode — the leading `!` runs the line in the shell instead of sending it to
 * the model. Coloured to match the bash-green input frame. Takes the indicator
 * slot ahead of the permission-mode label (a shell escape bypasses the model's
 * permission system, so that label — including the bypass-permissions warning —
 * would be misleading while it's active, and is suppressed).
 *
 * A function (not a const) so the label reads the active locale at call time.
 */
export function shellModeIndicator(): PermissionModeIndicator {
  return { label: t.status.shellMode, color: BASH_HEX };
}

/**
 * Colored label shown below the StatusLine for a non-default permission mode,
 * or null for `default` (no extra row). Each mode gets a distinct color for
 * at-a-glance distinction — green for accept-edits (writes flowing), yellow for
 * auto (writes plus unattended commands), cyan for plan (read-only), red for the
 * dangerous bypass. The PERMISSION_MODE_HINT is rendered after it in the
 * StatusLine's dim color. Cycled with shift+tab.
 */
export function permissionModeIndicator(mode: PermissionMode): PermissionModeIndicator | null {
  switch (mode) {
    case "acceptEdits":
      return { label: t.status.acceptEdits, color: "green" };
    case "auto":
      return { label: t.status.autoMode, color: "yellow" };
    case "plan":
      return { label: t.status.planMode, color: "cyan" };
    case "bypassPermissions":
      return { label: t.status.bypass, color: "red" };
    default:
      return null;
  }
}

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

/**
 * Elapsed time for the working spinner, e.g. `40s`, `1m, 30s`, `1h, 3m, 50s`.
 * Comma-separated units, leading zero units dropped, seconds always shown,
 * whole seconds (no decimals). Negative input clamps to `0s`.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h, ${m}m, ${s}s`;
  if (m > 0) return `${m}m, ${s}s`;
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

/**
 * Prompt-cache hit rate over *all* prompt input tokens: the fraction served
 * from cache out of (cache read + cache creation + uncached input). DeepSeek's
 * Anthropic-compatible usage splits every prompt into those three buckets, so
 * their sum is the full prompt size. Returns null when no prompt tokens have
 * been seen yet — there is no meaningful rate to show.
 */
export function cacheHitRate(read: number, creation: number, uncachedInput: number): number | null {
  const total = read + creation + uncachedInput;
  if (total <= 0) return null;
  return read / total;
}

/** A 0–1 ratio as a whole-percent string, e.g. 0.8523 → "85%". */
export function formatPercent(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  return `${Math.round(clamped * 100)}%`;
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
