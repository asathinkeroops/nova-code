import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { bold, type Rgb, useTruecolor } from "../colors.js";
import { UI_FRAME_MS } from "./frame.js";
import { LOGO_GRADIENT } from "./logo.js";
import { formatElapsed, formatTokenCount } from "./status-format.js";
import type { SpinnerSpec } from "./store.js";

// A twinkling nova instead of the stock braille spinner: the star flares open
// from a dim point to a full burst and settles back, looping seamlessly (the
// trailing ⁺ folds straight into the leading ·).
//
// The glyphs are exactly the wordmark's own starfield vocabulary — `· ⁺ ⋆ ✧ ✦`
// are the five sparkle characters LOGO is drawn with (see ui/logo.ts), ordered
// here by visual weight. The previous set (✶ ✸ ✺) appeared nowhere in the
// wordmark: a second, unrelated family of star shapes. All are single cells.
const FRAMES = ["·", "⁺", "⋆", "✧", "✦", "✦", "✧", "⋆", "⁺"];

// The animation runs at 1/ANIM_SLOWDOWN of the repaint cadence, so each star
// frame holds for ANIM_SLOWDOWN ticks (2 × UI_FRAME_MS = 160ms) — a calm
// twinkle rather than a fast flicker.
const ANIM_SLOWDOWN = 2;

// How far the colour sweep advances per animation frame, and how much it lags
// per character. One full out-and-back traverse of the arc is 2.0 units, so
// 0.052 puts the colour cycle at ~38.5 frames (6.2s) against the star's 9-frame
// (1.44s) pulse. The ratio (4.27) is deliberately not a whole number: at 0.055
// it lands on 4.04, close enough that every fourth pulse repeats the same
// colours and the whole thing visibly loops.
const ARC_SPEED = 0.052;
const ARC_SPREAD = 0.1;

/**
 * Sample the wordmark's cyan→magenta arc at `t`, ping-ponged (0→1→0 over two
 * units) rather than wrapped.
 *
 * Ping-pong matters: the arc's ends are light cyan and light pink, so a
 * sawetooth wrap snaps ~160/441 of the RGB cube in a single step — visible as a
 * hard seam sliding through the word. Reflecting instead keeps the sweep
 * continuous at every crossing.
 */
function arcAt(t: number): Rgb {
  const n = LOGO_GRADIENT.length - 1;
  const m = ((t % 2) + 2) % 2;
  const x = (1 - Math.abs(m - 1)) * n;
  const i = Math.min(Math.floor(x), n - 1);
  const f = x - i;
  const a = LOGO_GRADIENT[i] as Rgb;
  const b = LOGO_GRADIENT[i + 1] as Rgb;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/**
 * Paint `text` with the arc travelling outward along it — later characters lag,
 * so the light reads as radiating from the star rather than the whole line
 * changing colour at once. That is the wordmark's motif (a burst throwing
 * ejecta) rather than a generic loading throb.
 */
function shimmer(text: string, frame: number): string {
  let out = "\x1b[1m";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === " ") {
      out += ch;
      continue;
    }
    const [r, g, b] = arcAt(frame * ARC_SPEED - i * ARC_SPREAD);
    out += `\x1b[38;2;${r};${g};${b}m${ch}`;
  }
  return out + "\x1b[39m\x1b[22m";
}

interface SpinnerProps {
  spec: SpinnerSpec;
  /**
   * Standalone spinners reserve a blank line above and below for breathing room.
   * Footer-hosted spinners opt out so the list sits flush directly under the
   * title row ("待办: …"), without the extra blank line from the built-in margin.
   */
  compact?: boolean;
}

export function Spinner({ spec, compact = false }: SpinnerProps): React.ReactElement {
  const [frame, setFrame] = useState(0);

  const label = spec.label;
  const isStatic = typeof label === "string";
  const colorize = !isStatic && label.colorize ? label.colorize : (s: string): string => s;
  // Every animated spinner rides the one brand arc; what distinguishes them is
  // the word ("Working" vs "Running shell"), not a hue. The per-call-site tints
  // this used to take were both pinks a terminal renders near-identically.
  const canShimmer = !isStatic && useTruecolor;
  // One shared cadence with the live-draft flush so the two full-frame repaint
  // drivers stay in phase and coalesce instead of interleaving (see frame.ts).
  const tickMs = UI_FRAME_MS;

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => f + 1);
    }, tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  // spec.startedAt is anchored to the task (turn) start, not this spinner
  // instance, so the timer counts up across the whole task instead of resetting
  // when the working spinner is re-armed at a tool/permission phase.
  const elapsed = formatElapsed(Date.now() - spec.startedAt);
  // Advance the star pulse and color shimmer at half the repaint cadence so the
  // twinkle breathes instead of strobing. The tick itself stays at UI_FRAME_MS
  // (see frame.ts) so the elapsed timer still repaints smoothly; only the
  // animation phase is slowed.
  const phase = Math.floor(frame / ANIM_SLOWDOWN);
  const frameChar = FRAMES[phase % FRAMES.length] ?? "";
  const upStr = spec.inputTokens != null ? ` · ↑ ${formatTokenCount(spec.inputTokens)} tok` : "";
  const downStr = spec.tokens != null ? ` · ↓ ~${formatTokenCount(spec.tokens)} tok` : "";
  const tokenStr = `${upStr}${downStr}`;
  const hintStr = spec.hint ? ` · ${spec.hint}` : "";

  let line: string;
  if (canShimmer) {
    const head = shimmer(frameChar, phase + 1);
    const word = shimmer(spec.activeWord, phase);
    line = `${head} ${word} · ${elapsed}${tokenStr}${hintStr}`;
  } else {
    const renderedFrame = isStatic ? frameChar : bold(colorize(frameChar));
    const word = isStatic ? spec.activeWord : bold(colorize(spec.activeWord));
    line = `${renderedFrame} ${word} · ${elapsed}${tokenStr}${hintStr}`;
  }

  return (
    <Box
      marginTop={compact ? 0 : 1}
      marginBottom={compact ? 0 : 1}
      flexDirection="column"
    >
      <Text>{line}</Text>
    </Box>
  );
}
