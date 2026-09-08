import React from "react";
import { Box, Text } from "ink";
import { useTruecolor } from "../colors.js";
import { GLM_ART, GLM_ART_WIDTH, type BlockSpan } from "./glm-art.js";

/** White ring wrapped around the wordmark. `WIDTH` is its thickness in cells. */
const BORDER_HEX = "#ffffff";
const BORDER_WIDTH = 1;

/**
 * The Zhipu (GLM Coding Plan) wordmark rendered as a colored block image, shown
 * above the API key prompt on first-run setup — the dark mark on a white card,
 * mirroring the DeepSeek art's construction: each terminal row collapses two
 * pixel rows into the upper-half block `▀` (top pixel → foreground, bottom
 * pixel → background). See glm-art.ts for the offline sampling.
 *
 * Per-cell background color only reads correctly on truecolor terminals; on
 * 16/256-color terminals it would band into mud, so we render nothing there and
 * let the existing wordmark carry the branding.
 */
export function GlmArt(): React.ReactElement | null {
  if (!useTruecolor) return null;
  // A full white cell is `█` in white; used both for the top/bottom bars (a
  // full-width run) and the left/right posts (one BORDER_WIDTH run per art row).
  const bar = (
    <Text color={BORDER_HEX} backgroundColor={BORDER_HEX}>
      {"█".repeat(GLM_ART_WIDTH + BORDER_WIDTH * 2)}
    </Text>
  );
  const post = (
    <Text color={BORDER_HEX} backgroundColor={BORDER_HEX}>
      {"█".repeat(BORDER_WIDTH)}
    </Text>
  );
  return (
    <Box flexDirection="column">
      {Array.from({ length: BORDER_WIDTH }, (_, i) => (
        <React.Fragment key={`top-${i}`}>{bar}</React.Fragment>
      ))}
      {GLM_ART.map((row, y) => (
        <Text key={y}>
          {post}
          {row.map(([fg, bg, count]: BlockSpan, i) => (
            <Text key={i} color={fg} backgroundColor={bg}>
              {"▀".repeat(count)}
            </Text>
          ))}
          {post}
        </Text>
      ))}
      {Array.from({ length: BORDER_WIDTH }, (_, i) => (
        <React.Fragment key={`bot-${i}`}>{bar}</React.Fragment>
      ))}
    </Box>
  );
}
