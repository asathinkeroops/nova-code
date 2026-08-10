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

// The primary UI accent — brand violet. Used for chrome: prompts, slash
// commands, spinner, status line, panel top rules, modals. Markdown body text
// keeps real `cyan` instead (see `accent` vs `cyan` below).
//
// This used to be the wordmark gradient's *bottom* stop (#ff3caa, a hot
// magenta-pink), which made the whole terminal read pink while every other
// surface of the product reads violet. The wordmark spectrum runs
// cyan→blue→violet→magenta→pink; chrome belongs on the violet middle, not the
// pink tail. The swap is contrast-neutral (6.5:1 → 5.3:1 on near-black, 3.2:1 →
// 4.0:1 on near-white — better on light terminals), so it costs no legibility.
//
// The banner keeps the full spectrum verbatim (see LOGO_GRADIENT in ui/logo.ts);
// #ff3caa survives there as its tail, which is the small-surface role it should
// have had all along. The two are no longer meant to match — do not "re-sync" them.
export const ACCENT_RGB: Rgb = [168, 85, 247];
/** The accent as a hex string, for Ink `<Text color>` props. */
export const ACCENT_HEX = "#a855f7";

/**
 * Fill behind an *active* chip (white text on top), e.g. the `/ask` tab strip.
 *
 * Deliberately NOT `ACCENT_HEX`: white-on-#a855f7 is only 4.0:1, under AA. This
 * is the brand's primary violet, which is unusable as terminal *text* (2.96:1 on
 * near-black) but ideal as a *fill* — white on it clears 7.1:1. Backgrounds are
 * the one place the darker end of the brand palette works in a terminal.
 */
export const CHIP_ACTIVE_BG_HEX = "#6d28d9";

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

/** Manual/default — a violet-leaning grey: recessive next to the other modes, but still readable. */
export const MODE_MANUAL_HEX = "#bfb8cf";
/** Accept-edits — green (writes flow, commands still ask). Brand `--ok`. */
export const MODE_ACCEPT_HEX = "#46c77e";
/** Auto — amber (writes plus unattended commands). Brand `--warn`. */
export const MODE_AUTO_HEX = "#e9a23b";
/** Plan — bright cyan (read-only). */
export const MODE_PLAN_HEX = "#22d3ee";
/** Bypass — hot red (all gating off). */
export const MODE_BYPASS_HEX = "#ff5f56";

/**
 * Candidate backgrounds for the session-name badge (`/rename`). A session name
 * is hashed to one of these (see {@link sessionBadgeColor}) so each named window
 * gets a stable, distinct colour — making it easy to tell several open sessions
 * apart at a glance.
 *
 * Ten hue-equidistant samples across the wordmark spectrum's arc (184°→326°,
 * i.e. its cyan end through its pink end), each darkened until white badge text
 * clears 4.6:1. The previous set was a generic CSS-framework default palette
 * whose hues (red, amber, emerald, olive) had nothing to do with the brand and
 * whose worst entry sat at 3.1:1 under its own white text. Sampling one arc
 * instead fixes both: every entry now clears AA, and adjacent entries are
 * *further* apart in RGB than before (34.8 vs 32.1), so sessions stay as easy to
 * tell apart as they were.
 *
 * The badge colour doubles as the input-box frame tint, which is foreground on
 * the user's terminal background — that role is decorative and its contrast
 * floor is unchanged from the old palette (3.3:1 on near-black).
 */
export const SESSION_BADGE_PALETTE = [
  "#06828a", // cyan
  "#087cb6", // sky
  "#106df5", // blue
  "#3b56f7", // indigo
  "#513bf7", // iris
  "#833bf7", // violet
  "#af2ff6", // purple
  "#c909dd", // orchid
  "#d609b3", // magenta
  "#e10983", // pink
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
// Primary UI accent (brand violet, #a855f7). Truecolor uses the exact RGB;
// 16-colour falls back to magenta — one hue off, but the 16-colour blue is
// already spoken for by links and inline code, so magenta keeps the roles
// apart. UI chrome uses this; markdown body text uses `cyan` above.
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
// Chrome violet (thinking labels). Shares ACCENT_RGB: chrome is one colour, and
// the old #7c3aed only managed 3.7:1 on a near-black terminal — the background
// most of these labels are actually read on.
export const purple = (s: string): string => {
  if (!useColor) return s;
  if (useTruecolor) return rgbFg(ACCENT_RGB, s);
  return wrap(35, 39, s);
};
// Inline-code violet (#a78bfa) — a lighter, blue-leaning sibling of the chrome
// accent (#a855f7). Chrome is saturated and appears in fixed positions; this is
// body-sized text that recurs many times per paragraph next to plain white
// prose, so it is pulled up to ~7.7:1 on a near-black background where the
// chrome violet sits at 5.3:1 and the brand's darker #6d28d9 sits at ~3:1 and
// goes muddy at small monospace sizes. Picked by eye against a real transcript —
// darker (#8b5cf6, 4.7:1) and desaturated grey-violets both lost the code spans
// in the prose. The two violets are close enough to read as one family and far
// enough apart in lightness to stay distinguishable when adjacent.
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
 * to list markers, blue to links, violet to inline code, and the accent violet
 * to chrome — so a heading never competes with the spans inside it.
 *
 * The ramp is anchored on the wordmark spectrum's magenta stop (#e650d2) at H3
 * and tinted/shaded from there, replacing an orchid-pink family that sat outside
 * the brand hues. The luminance ladder is deliberately unchanged step for step
 * (~11.3 / 8.5 / 6.4 / 4.2 on near-black, vs ~11.2 / 8.4 / 6.3 / 4.7 before), so
 * this reads as the same ramp in a corrected hue rather than as a new one.
 *
 * H4-H6 share the floor rather than continuing to darken. Below roughly 4:1 a
 * bold heading starts reading as disabled text, and levels that deep are rare
 * enough that legibility beats one more step of contrast.
 */
const HEADING_RAMP: readonly Rgb[] = [
  [240, 166, 230], // H1  ~11:1 on near-black
  [236, 124, 220], // H2  ~8.5:1
  [230, 80, 210], // H3  ~6.4:1  — the wordmark spectrum's magenta stop
  [180, 63, 164], // H4  ~4.2:1
  [180, 63, 164], // H5
  [180, 63, 164], // H6
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
