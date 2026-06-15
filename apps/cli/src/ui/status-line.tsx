import React from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import { useShallow } from "zustand/react/shallow";
import { ACCENT_HEX } from "../colors.js";
import type { AppStoreApi } from "./store.js";
import {
  cacheHitRate,
  contextBar,
  displayCwd,
  fitSegments,
  formatPercent,
  formatTokenCount,
  SHELL_MODE_INDICATOR,
  type StatusSegment,
} from "./status-format.js";

interface StatusLineProps {
  store: AppStoreApi;
  /**
   * When the input is in shell (`!`) mode, the status row collapses to just the
   * green `! for shell mode` hint — every other segment is hidden so the mode
   * reads at a glance. Wired by App from the permanent InputBox.
   */
  shellMode?: boolean;
}

/**
 * A single always-reserved row above the InputBox. It normally renders the
 * session status — model, context-window usage, workspace, git
 * branch, and directory — fitted to the terminal width (rightmost segments
 * drop first when space runs out). The transient "✓ copied" notice from a
 * mouse-drag selection takes over the row for its short lifetime. Permanent
 * layout slot: the row is one line whether or not anything is shown, so
 * toggling content never shifts the InputBox or the viewport.
 */
export function StatusLine({ store, shellMode = false }: StatusLineProps): React.ReactElement {
  const {
    copyNotice,
    banner,
    gitBranch,
    contextTokens,
    contextWindowTokens,
    cacheReadTokens,
    cacheCreationTokens,
    uncachedInputTokens,
    termCols,
  } = store(
    useShallow((s) => ({
      copyNotice: s.copyNotice,
      banner: s.banner,
      gitBranch: s.gitBranch,
      contextTokens: s.contextTokens,
      contextWindowTokens: s.contextWindowTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      uncachedInputTokens: s.uncachedInputTokens,
      termCols: s.termCols,
    })),
  );

  // Shell mode collapses the whole row to just the `!` hint — every segment is
  // hidden. Checked ahead of the copy notice so the mode stays unambiguous
  // while a `!` line is being typed.
  if (shellMode) {
    return (
      <Box>
        <Text color={SHELL_MODE_INDICATOR.color}>{` ${SHELL_MODE_INDICATOR.label}`}</Text>
      </Box>
    );
  }

  if (copyNotice) {
    return (
      <Box>
        <Text color="green">{` ${copyNotice}`}</Text>
      </Box>
    );
  }

  const segments: StatusSegment[] = [];
  if (banner?.model) {
    const window = contextWindowTokens > 0 ? ` (${formatTokenCount(contextWindowTokens)})` : "";
    segments.push({ icon: "◆", text: `${banner.model.toUpperCase()}${window}`, color: "magenta" });
  }
  if (contextWindowTokens > 0) {
    const pct = Math.min(100, Math.round((contextTokens / contextWindowTokens) * 100));
    segments.push({ icon: "○", text: `${contextBar(pct)} ${pct}%`, color: "yellow" });
  }
  const hitRate = cacheHitRate(cacheReadTokens, cacheCreationTokens, uncachedInputTokens);
  if (hitRate !== null) {
    segments.push({ icon: "⚡", text: `${formatPercent(hitRate)} cache`, color: "cyan" });
  }
  if (banner?.cwd) {
    segments.push({ icon: "◈", text: basename(banner.cwd) || banner.cwd, color: "green" });
  }
  if (gitBranch) {
    segments.push({ icon: "⎇", text: gitBranch, color: "blue" });
  }
  if (banner?.cwd) {
    segments.push({ icon: "•", text: displayCwd(banner.cwd, banner.home), color: ACCENT_HEX });
  }

  // Reserve one leading space (alignment) and one trailing cell (overflow margin).
  const shown = fitSegments(segments, Math.max(0, termCols - 2));

  return (
    <Box>
      <Text>{" "}</Text>
      {shown.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Text dimColor>{" | "}</Text> : null}
          <Text color={seg.color}>{seg.icon} </Text>
          <Text dimColor>{seg.text}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
