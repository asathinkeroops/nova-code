import React from "react";
import { Box, Text } from "ink";
import { useTruecolor } from "../colors.js";
import { MOONSHOT_ART, type BlockSpan } from "./moonshot-art.js";

/**
 * The Moonshot (Kimi) wordmark rendered as a colored block image, shown above
 * the API key prompt on first-run setup when the Moonshot provider is chosen.
 * Same upper-half-block (`▀`) technique as {@link DeepSeekArt} — each terminal
 * row is two pixel rows, fg the top pixel and bg the bottom — but the mark is
 * pure white, so it sits on a black card rather than DeepSeek's white one.
 *
 * Per-cell background color only reads correctly on truecolor terminals; on
 * 16/256-color terminals it would band into mud, so we render nothing there and
 * let the existing wordmark carry the branding.
 */
export function MoonshotArt(): React.ReactElement | null {
  if (!useTruecolor) return null;
  return (
    <Box flexDirection="column">
      {MOONSHOT_ART.map((row, y) => (
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
