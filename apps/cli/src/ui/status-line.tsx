import React from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import { useShallow } from "zustand/react/shallow";
import type { AppStoreApi } from "./store.js";
import {
  contextBar,
  displayCwd,
  fitSegments,
  formatDuration,
  formatTokenCount,
  type StatusSegment,
} from "./status-format.js";

interface StatusLineProps {
  store: AppStoreApi;
}

/**
 * A single always-reserved row above the InputBox. It normally renders the
 * session status — elapsed time, model, context-window usage, workspace, git
 * branch, and directory — fitted to the terminal width (rightmost segments
 * drop first when space runs out). The transient "✓ copied" notice from a
 * mouse-drag selection takes over the row for its short lifetime. Permanent
 * layout slot: the row is one line whether or not anything is shown, so
 * toggling content never shifts the InputBox or the viewport.
 */
export function StatusLine({ store }: StatusLineProps): React.ReactElement {
  const {
    copyNotice,
    banner,
    sessionStartedAt,
    gitBranch,
    contextTokens,
    contextWindowTokens,
    termCols,
  } = store(
    useShallow((s) => ({
      copyNotice: s.copyNotice,
      banner: s.banner,
      sessionStartedAt: s.sessionStartedAt,
      gitBranch: s.gitBranch,
      contextTokens: s.contextTokens,
      contextWindowTokens: s.contextWindowTokens,
      termCols: s.termCols,
    })),
  );

  // Tick once a second so the elapsed clock advances without other state churn.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (copyNotice) {
    return (
      <Box>
        <Text color="green">{` ${copyNotice}`}</Text>
      </Box>
    );
  }

  const segments: StatusSegment[] = [];
  if (sessionStartedAt != null) {
    segments.push({ icon: "⏱", text: formatDuration(now - sessionStartedAt), color: "cyan" });
  }
  if (banner?.model) {
    const window =
      contextWindowTokens > 0 ? ` (${formatTokenCount(contextWindowTokens)} CONTEXT)` : "";
    segments.push({ icon: "◆", text: `${banner.model.toUpperCase()}${window}`, color: "magenta" });
  }
  if (contextWindowTokens > 0) {
    const pct = Math.min(100, Math.round((contextTokens / contextWindowTokens) * 100));
    segments.push({ icon: "○", text: `${contextBar(pct)} ${pct}%`, color: "yellow" });
  }
  if (banner?.cwd) {
    segments.push({ icon: "◈", text: basename(banner.cwd) || banner.cwd, color: "green" });
  }
  if (gitBranch) {
    segments.push({ icon: "⎇", text: gitBranch, color: "blue" });
  }
  if (banner?.cwd) {
    segments.push({ icon: "•", text: displayCwd(banner.cwd, banner.home), color: "cyan" });
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
