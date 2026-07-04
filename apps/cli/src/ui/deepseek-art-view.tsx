import React from "react";
import { Box, Text } from "ink";
import { useTruecolor } from "../colors.js";
import { DEEPSEEK_ART, type BlockSpan } from "./deepseek-art.js";

/**
 * The DeepSeek wordmark rendered as a colored block image, shown above the API
 * key prompt on first-run setup. Each source row is two pixel rows collapsed
 * into one terminal row via the upper-half block `▀`: the glyph's top half
 * takes the cell's foreground color (the top pixel) and its bottom half the
 * background color (the bottom pixel), doubling vertical resolution. The image
 * is faithful to the source — the blue mark on a white card.
 *
 * Adjacent cells sharing the same (fg, bg) pair are pre-merged into a single
 * {@link BlockSpan} run offline (see deepseek-art.ts), so one row is a handful
 * of `<Text>` spans rather than 76 per-cell nodes.
 *
 * Per-cell background color only reads correctly on truecolor terminals; on
 * 16/256-color terminals it would band into mud, so we render nothing there and
 * let the existing wordmark carry the branding.
 */
export function DeepSeekArt(): React.ReactElement | null {
  if (!useTruecolor) return null;
  return (
    <Box flexDirection="column">
      {DEEPSEEK_ART.map((row, y) => (
        <Text key={y}>
          {row.map(([fg, bg, count]: BlockSpan, i) => (
            <Text key={i} color={fg} backgroundColor={bg}>
              {"▀".repeat(count)}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
