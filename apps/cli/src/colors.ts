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

/**
 * Re-open `openSeq` after every nested `closeSeq` already inside `text`.
 *
 * ANSI closers are SHARED, not per-attribute: bold(1) and dim(2) both end with
 * `22` ("normal intensity"), and every foreground colour ends with `39`. So a
 * nested span that ends mid-string silently turns the OUTER attribute off for
 * everything after it — `dim("a" + bold("b") + "c")` rendered "c" at normal
 * intensity, an H4-H6 heading lost both bold and dim after an inline `**`, and a
 * table header cell containing `**` stopped being bold partway through. Splicing
 * our own opener back in after each inner close makes the outer attribute
 * survive to the real end, which is what the nesting reads as.
 */
function reopen(text: string, closeSeq: string, openSeq: string): string {
  return text.includes(closeSeq) ? text.split(closeSeq).join(closeSeq + openSeq) : text;
}

export function rgbFg([r, g, b]: Rgb, text: string): string {
  if (!useColor) return text;
  const open = `\x1b[38;2;${r};${g};${b}m`;
  return `${open}${reopen(text, "\x1b[39m", open)}\x1b[39m`;
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

// Permission-mode label colours (see `ui/status-format.ts`). Saturated hexes
// rather than the base ANSI names — the 16-colour `green`/`yellow`/`cyan`/`red`
// render washed out on most terminal themes, and this row is the one piece of
// chrome that must stay readable at a glance. Each mode gets its own hue *and*
// its own glyph (the glyph lives in the i18n label), so the row stays legible
// without relying on colour alone.

/** Manual/default — a light grey: recessive next to the other modes, but still readable. */
export const MODE_MANUAL_HEX = "#b8c1cf";
/** Accept-edits — bright green (writes flow, commands still ask). */
export const MODE_ACCEPT_HEX = "#3ddc84";
/** Auto — amber (writes plus unattended commands). */
export const MODE_AUTO_HEX = "#ffb454";
/** Plan — bright cyan (read-only). */
export const MODE_PLAN_HEX = "#22d3ee";
/** Bypass — hot red (all gating off). */
export const MODE_BYPASS_HEX = "#ff5f56";

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
  const openSeq = `\x1b[${open}m`;
  const closeSeq = `\x1b[${close}m`;
  return `${openSeq}${reopen(text, closeSeq, openSeq)}${closeSeq}`;
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
// Inline-code violet (#a78bfa) — a blue-leaning purple, not the pink-leaning
// kind. Distinct from `purple` (#7c3aed) above, which is chrome (thinking
// labels, panel top rules): this one is body-sized text that recurs many times
// per paragraph next to plain white prose, so it is pulled up to ~7.3:1 on a
// near-black background where #7c3aed sits at ~2.5:1 and goes muddy at small
// monospace sizes. Picked by eye against a real transcript — darker (#8b5cf6,
// 4.7:1) and desaturated grey-violets both lost the code spans in the prose.
//
// The 16-colour fallback is blue(34), NOT the nearer magenta(35): headings are
// magenta, so falling back there made inline code and an H1 the same colour with
// only bold telling them apart. Blue is one hue off but keeps the two roles
// separate, which matters more at 16 colours than hue fidelity does.
export const violet = (s: string): string => {
  if (!useColor) return s;
  if (useTruecolor) return rgbFg([167, 139, 250], s);
  return wrap(34, 39, s);
};
/**
 * Heading ramp: ONE hue, descending brightness, index 0 = H1.
 *
 * Depth used to be signalled three different ways at once — hue for H1/H2
 * (magenta, then cyan), plain weight for H3, weight+dim for H4-H6 — which was
 * not even monotonic: nothing made cyan read as "below" magenta, so H1 and H2
 * looked like two unrelated kinds of heading rather than two levels of one.
 * A single luminance scale carries depth on its own, and every level is drawn
 * bold on top of it, so the ramp never has to double as emphasis.
 *
 * The magenta family is deliberate: it is the one hue left free after cyan went
 * to list markers, blue to links, and violet to inline code — so a heading never
 * competes with the spans inside it.
 *
 * H4-H6 share the floor rather than continuing to darken. Below roughly 4:1 a
 * bold heading starts reading as disabled text, and levels that deep are rare
 * enough that legibility beats one more step of contrast.
 */
const HEADING_RAMP: readonly Rgb[] = [
  [232, 168, 232], // H1  ~10:1 on near-black
  [206, 142, 206], // H2  ~7:1
  [182, 118, 182], // H3  ~5:1
  [158, 98, 158], // H4  ~4:1
  [158, 98, 158], // H5
  [158, 98, 158], // H6
];

/**
 * Colour a heading body for `level` (1-6, clamped). Truecolor only; 16-colour
 * terminals collapse the whole ramp onto magenta(35). That is safe precisely
 * because the renderer keeps the literal `#` markers in its output — the level
 * is legible from the text itself, so colour only ever has to reinforce it.
 */
export function headingColor(level: number, s: string): string {
  if (!useColor) return s;
  if (!useTruecolor) return wrap(35, 39, s);
  const idx = Math.min(Math.max(Math.trunc(level), 1), HEADING_RAMP.length) - 1;
  return rgbFg(HEADING_RAMP[idx]!, s);
}
export const bold = (s: string): string => wrap(1, 22, s);
export const italic = (s: string): string => wrap(3, 23, s);
export const underline = (s: string): string => wrap(4, 24, s);
export const strike = (s: string): string => wrap(9, 29, s);
