function detectColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!process.stdout.isTTY;
}

export const useColor = detectColor();

function detectTruecolor(): boolean {
  if (!useColor) return false;
  const ct = process.env.COLORTERM;
  if (ct === "truecolor" || ct === "24bit") return true;
  const term = process.env.TERM_PROGRAM;
  if (
    term === "iTerm.app" ||
    term === "WezTerm" ||
    term === "ghostty" ||
    term === "vscode"
  )
    return true;
  return false;
}

export const useTruecolor = detectTruecolor();

export type Rgb = readonly [number, number, number];

export function rgbFg([r, g, b]: Rgb, text: string): string {
  if (!useColor) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

// The primary UI accent — the banner logo's bottom gradient stop, a hot
// magenta-pink. Used for chrome: prompts, slash commands, spinner, status line,
// modals. Markdown body text keeps real `cyan` instead (see `accent` vs `cyan`
// below). Matches LOGO_GRADIENT's bottom wordmark stop (the row just above the
// trailing starfield) in ui/logo.ts — keep the two in sync.
export const ACCENT_RGB: Rgb = [255, 60, 170];
/** The accent as a hex string, for Ink `<Text color>` props. */
export const ACCENT_HEX = "#ff3caa";

/** Purple (#7c3aed) as a hex string, for Ink border/`<Text color>` props. */
export const PURPLE_HEX = "#7c3aed";

/** Blue (#2563eb) as RGB, for `rgbFg` string tinting (e.g. the "Beta" badge on setup). */
export const BLUE_RGB: Rgb = [37, 99, 235];

/**
 * Bash-mode accent (green) for the InputBox frame when the buffer is a `!`
 * shell command. Signals that the line runs in the shell, not the model.
 */
export const BASH_HEX = "#7fd99a";

/**
 * Candidate backgrounds for the session-name badge (`/rename`). A session name
 * is hashed to one of these (see {@link sessionBadgeColor}) so each named window
 * gets a stable, distinct colour — making it easy to tell several open sessions
 * apart at a glance. All are saturated mid-dark tones chosen for contrast with
 * the badge's white text.
 */
export const SESSION_BADGE_PALETTE = [
  "#2563eb", // blue
  "#7c3aed", // purple
  "#0d9488", // teal
  "#dc2626", // red
  "#d97706", // amber
  "#059669", // emerald
  "#db2777", // pink
  "#4f46e5", // indigo
  "#0284c7", // sky
  "#65a30d", // olive
] as const;

/**
 * Map a session name to a stable palette colour. Deterministic (same name →
 * same colour across windows and restarts) via a small djb2-style hash over the
 * trimmed name. Empty name falls back to the first entry.
 */
export function sessionBadgeColor(name: string): string {
  const key = name.trim();
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  const idx = h % SESSION_BADGE_PALETTE.length;
  return SESSION_BADGE_PALETTE[idx] ?? SESSION_BADGE_PALETTE[0];
}

export const MAGENTA_RGB: Rgb = [220, 130, 220];

// Selection background for the input box, matching the steel-blue band the
// viewport selection paints (`ui/selection.ts`, rgb(45,80,130)) so a drag in
// either region reads identically. Used as an Ink `backgroundColor` (hex).
export const SELECTION_BG_HEX = "#2d5082";

// Diff row colours — kept in sync with the canonical renderer in ui/diff.ts so
// the `/diff` viewer and inline tool diffs look identical. Dark row tints with
// brighter foreground signs.
export const DIFF_ADD_BG: Rgb = [14, 68, 41];
export const DIFF_DEL_BG: Rgb = [73, 15, 15];
export const DIFF_ADD_FG: Rgb = [127, 217, 154];
export const DIFF_DEL_FG: Rgb = [255, 128, 128];

/**
 * Paint a background tint behind `text` for a diff row. The inner `[39m`/`[22m`
 * fg/dim resets in `text` don't touch the background, so any foreground colour
 * (e.g. syntax highlighting) already in `text` is preserved. Returns `text`
 * unchanged when colour is disabled.
 */
export function diffTint(kind: "add" | "del", text: string): string {
  if (!useColor) return text;
  const [r, g, b] = kind === "add" ? DIFF_ADD_BG : DIFF_DEL_BG;
  return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}

/** The coloured `+`/`-` marker for an add/remove row. */
export function diffSign(kind: "add" | "del"): string {
  const sign = kind === "add" ? "+" : "-";
  return rgbFg(kind === "add" ? DIFF_ADD_FG : DIFF_DEL_FG, sign);
}

function wrap(open: number, close: number, text: string): string {
  if (!useColor) return text;
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

export const green = (s: string): string => wrap(32, 39, s);
export const red = (s: string): string => wrap(31, 39, s);
export const dim = (s: string): string => wrap(2, 22, s);
export const cyan = (s: string): string => wrap(36, 39, s);
// Primary UI accent (hot magenta-pink, #ff3caa). Truecolor uses the exact RGB;
// 16-colour falls back to magenta, the nearest palette match. UI chrome uses
// this; markdown body text uses `cyan` above.
export const accent = (s: string): string => {
  if (!useColor) return s;
  if (useTruecolor) return rgbFg(ACCENT_RGB, s);
  return wrap(35, 39, s);
};
export const blue = (s: string): string => wrap(34, 39, s);
export const gray = (s: string): string => wrap(90, 39, s);
export const yellow = (s: string): string => wrap(33, 39, s);
export const magenta = (s: string): string => wrap(35, 39, s);
export const orange = (s: string): string => {
  if (!useColor) return s;
  if (useTruecolor) return rgbFg([255, 140, 50], s);
  return wrap(33, 39, s);
};
export const purple = (s: string): string => {
  if (!useColor) return s;
  if (useTruecolor) return rgbFg([124, 58, 237], s);
  return wrap(35, 39, s);
};
export const bold = (s: string): string => wrap(1, 22, s);
export const italic = (s: string): string => wrap(3, 23, s);
export const underline = (s: string): string => wrap(4, 24, s);
export const strike = (s: string): string => wrap(9, 29, s);
