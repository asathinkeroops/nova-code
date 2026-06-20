import { accent, blue, magenta, rgbFg, useTruecolor, type Rgb } from "../colors.js";

// The wordmark drawn at startup (and on the first-run setup panel). Shared so
// the string-based banner and the Ink-based setup view stay byte-for-byte in
// sync.
export const LOGO = [
  "██   ██  ████  ██   ██  █████         █████  ████  █████  ██████",
  "███  ██ ██  ██ ██   ██ ██   ██       ██     ██  ██ ██  ██ ██    ",
  "██ █ ██ ██  ██ ██   ██ ███████ █████ ██     ██  ██ ██  ██ █████ ",
  "██  ███ ██  ██  ██ ██  ██   ██       ██     ██  ██ ██  ██ ██    ",
  "██   ██  ████    ███   ██   ██        █████  ████  █████  ██████",
];

// Cyberpunk vertical gradient (cyan → magenta), one stop per LOGO row.
export const LOGO_GRADIENT: Rgb[] = [
  [0, 238, 255],
  [90, 160, 255],
  [170, 110, 245],
  [230, 80, 210],
  [255, 60, 170],
];

// 16-color fallback for terminals without truecolor, tracing the same arc.
const LOGO_FALLBACK = [accent, blue, magenta, magenta, magenta];

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
