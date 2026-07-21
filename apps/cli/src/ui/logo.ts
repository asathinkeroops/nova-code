import { accent, blue, magenta, rgbFg, useTruecolor, type Rgb } from "../colors.js";

// The wordmark drawn at startup (and on the first-run setup panel). Shared so
// the string-based banner and the Ink-based setup view stay byte-for-byte in
// sync.
//
// "nova" is a star flaring bright, so the wordmark sits inside a supernova
// burst: a scattered starfield above and below, and sparkle gutters flanking
// each row that thicken toward the center (rows 3–4) like ejecta thrown off
// the core. Each row is colored by its gradient stop (below), so the sparkles
// share the cyan→magenta arc and read as one radiating whole.
export const LOGO = [
  "      ·           ⋆                ✦                ⋆           ·       ",
  "  ⋆   ██   ██  ████  ██   ██  █████         █████  ████  █████  ██████  ⋆  ",
  " ✧ ·  ███  ██ ██  ██ ██   ██ ██   ██       ██     ██  ██ ██  ██ ██     · ✧ ",
  "✦ ⁺   ██ █ ██ ██  ██ ██   ██ ███████ █████ ██     ██  ██ ██  ██ █████   ⁺ ✦",
  " · ✧  ██  ███ ██  ██  ██ ██  ██   ██       ██     ██  ██ ██  ██ ██     ✧ · ",
  "  ⋆   ██   ██  ████    ███   ██   ██        █████  ████  █████  ██████  ⋆  ",
  "       ⁺        ·             ⋆          ·          ✦             ⁺        ",
];

// Cyberpunk vertical gradient (cyan → magenta), one stop per LOGO row. The
// outer starfield rows (first/last) take the bright extremes so the burst
// glows hottest at its edges.
export const LOGO_GRADIENT: Rgb[] = [
  [140, 246, 255],
  [0, 238, 255],
  [90, 160, 255],
  [170, 110, 245],
  [230, 80, 210],
  [255, 60, 170],
  [255, 140, 215],
];

// 16-color fallback for terminals without truecolor, tracing the same arc.
const LOGO_FALLBACK = [accent, accent, blue, magenta, magenta, magenta, magenta];

/** Color one LOGO row by its vertical position, degrading like `orange`. */
export function bannerLine(line: string, row: number): string {
  if (useTruecolor) {
    const stop = LOGO_GRADIENT[row];
    return stop ? rgbFg(stop, line) : accent(line);
  }
  return (LOGO_FALLBACK[row] ?? accent)(line);
}

const toHex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** Per-row hex colors for the gradient, for Ink `<Text color>` props. */
export const LOGO_ROW_HEX: string[] = LOGO_GRADIENT.map(toHex);
