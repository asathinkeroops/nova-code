import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { bold, type Rgb, useTruecolor } from "../colors.js";
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
  const tickMs = canShimmer ? 60 : 80;

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => f + 1);
    }, tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  const elapsed = ((Date.now() - spec.startedAt) / 1000).toFixed(1);
  const frameChar = FRAMES[frame % FRAMES.length] ?? "";
  const hintStr = spec.hint ? ` · ${spec.hint}` : "";

  let line: string;
  if (canShimmer && tint) {
    const head = shimmer(frameChar, frame + 1, tint);
    const word = shimmer(spec.activeWord, frame, tint);
    line = `${head} ${word} · ${elapsed}s${hintStr}`;
  } else {
    const renderedFrame = isStatic ? frameChar : bold(colorize(frameChar));
    const word = isStatic ? spec.activeWord : bold(colorize(spec.activeWord));
    line = `${renderedFrame} ${word} · ${elapsed}s${hintStr}`;
  }

  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{line}</Text>
    </Box>
  );
}
