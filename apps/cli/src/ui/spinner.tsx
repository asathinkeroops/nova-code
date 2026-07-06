import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { bold, type Rgb, useTruecolor } from "../colors.js";
import { UI_FRAME_MS } from "./frame.js";
import { formatElapsed, formatTokenCount } from "./status-format.js";
import type { SpinnerSpec } from "./store.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function shimmer(text: string, frame: number, [r, g, b]: Rgb): string {
  let out = "\x1b[1m";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === " ") {
      out += ch;
      continue;
    }
    const t = frame * 0.18 - i * 0.32;
    const wave = (Math.sin(t) + 1) / 2;
    const k = 0.45 + 0.55 * wave;
    out += `\x1b[38;2;${Math.round(r * k)};${Math.round(g * k)};${Math.round(b * k)}m${ch}`;
  }
  return out + "\x1b[39m\x1b[22m";
}

interface SpinnerProps {
  spec: SpinnerSpec;
}

export function Spinner({ spec }: SpinnerProps): React.ReactElement {
  const [frame, setFrame] = useState(0);

  const label = spec.label;
  const isStatic = typeof label === "string";
  const tint = isStatic ? undefined : label.tint;
  const colorize = !isStatic && label.colorize ? label.colorize : (s: string): string => s;
  const canShimmer = !!tint && useTruecolor;
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
  // when the working spinner is recreated per model-call / tool phase.
  const elapsed = formatElapsed(Date.now() - spec.startedAt);
  const frameChar = FRAMES[frame % FRAMES.length] ?? "";
  const upStr = spec.inputTokens != null ? ` · ↑ ${formatTokenCount(spec.inputTokens)} tok` : "";
  const downStr = spec.tokens != null ? ` · ↓ ~${formatTokenCount(spec.tokens)} tok` : "";
  const tokenStr = `${upStr}${downStr}`;
  const hintStr = spec.hint ? ` · ${spec.hint}` : "";

  let line: string;
  if (canShimmer && tint) {
    const head = shimmer(frameChar, frame + 1, tint);
    const word = shimmer(spec.activeWord, frame, tint);
    line = `${head} ${word} · ${elapsed}${tokenStr}${hintStr}`;
  } else {
    const renderedFrame = isStatic ? frameChar : bold(colorize(frameChar));
    const word = isStatic ? spec.activeWord : bold(colorize(spec.activeWord));
    line = `${renderedFrame} ${word} · ${elapsed}${tokenStr}${hintStr}`;
  }

  return (
    <Box marginTop={1} marginBottom={1} flexDirection="column">
      <Text>{line}</Text>
    </Box>
  );
}
