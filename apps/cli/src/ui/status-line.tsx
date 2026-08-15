import React from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import { useShallow } from "zustand/react/shallow";
import { computeCost, formatMoney } from "@nova/runtime";
import { ACCENT_HEX } from "../colors.js";
import { t } from "../i18n/index.js";
import type { AppStoreApi } from "./store.js";
import {
  cacheHitRate,
  cacheSegmentText,
  contextBar,
  displayCwd,
  fitSegments,
  formatTokenCount,
  shellModeIndicator,
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

/** Render one fitted row of status segments (leading space + ` | ` joins). */
function SegmentRow({
  segments,
  termCols,
}: {
  segments: StatusSegment[];
  termCols: number;
}): React.ReactElement {
  // Reserve one leading space (alignment) and one trailing cell (overflow margin).
  const shown = fitSegments(segments, Math.max(0, termCols - 2));
  return (
    <Box>
      <Text>{" "}</Text>
      {shown.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Text dimColor>{" | "}</Text> : null}
          {/* Icon and text share the segment color so each reads as one unit. */}
          <Text color={seg.color}>
            {seg.icon} {seg.text}
          </Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

/**
 * Two always-reserved rows above the InputBox. The first renders the session
 * status — model, context-window usage, workspace, git branch, and directory;
 * the second renders usage — prompt-cache hit rate (this session and all-time)
 * and session prompt / output token totals. Each row is fitted independently
 * (rightmost segments drop first when space runs out). The transient "✓ copied"
 * notice from a mouse-drag selection takes over the first row for its short
 * lifetime (the second stays blank). Permanent layout slot: the block is always
 * two lines whether or not anything is shown, so toggling content never shifts
 * the InputBox or the viewport.
 */
export function StatusLine({ store, shellMode = false }: StatusLineProps): React.ReactElement {
  const {
    copyNotice,
    copyNoticeTone,
    banner,
    gitBranch,
    contextTokens,
    contextWindowSize,
    cacheReadTokens,
    cacheCreationTokens,
    uncachedInputTokens,
    lifetimeCacheReadTokens,
    lifetimeCacheCreationTokens,
    lifetimeUncachedInputTokens,
    sessionOutputTokens,
    costRates,
    accountBalance,
    termCols,
  } = store(
    useShallow((s) => ({
      copyNotice: s.copyNotice,
      copyNoticeTone: s.copyNoticeTone,
      banner: s.banner,
      gitBranch: s.gitBranch,
      contextTokens: s.contextTokens,
      contextWindowSize: s.contextWindowSize,
      cacheReadTokens: s.cacheReadTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      uncachedInputTokens: s.uncachedInputTokens,
      lifetimeCacheReadTokens: s.lifetimeCacheReadTokens,
      lifetimeCacheCreationTokens: s.lifetimeCacheCreationTokens,
      lifetimeUncachedInputTokens: s.lifetimeUncachedInputTokens,
      sessionOutputTokens: s.sessionOutputTokens,
      costRates: s.costRates,
      accountBalance: s.accountBalance,
      termCols: s.termCols,
    })),
  );

  // Shell mode collapses the first row to just the `!` hint — every segment is
  // hidden. Checked ahead of the copy notice so the mode stays unambiguous
  // while a `!` line is being typed. The second row stays blank so the pinned
  // two-row height never changes.
  if (shellMode) {
    const shell = shellModeIndicator();
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={shell.color}>{` ${shell.label}`}</Text>
        </Box>
        <Box>
          <Text>{" "}</Text>
        </Box>
      </Box>
    );
  }

  if (copyNotice) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={copyNoticeTone === "warn" ? "red" : "green"}>{` ${copyNotice}`}</Text>
        </Box>
        <Box>
          <Text>{" "}</Text>
        </Box>
      </Box>
    );
  }

  // First row: model / context / workspace / branch / directory.
  const main: StatusSegment[] = [];
  if (banner?.model) {
    // concrete-id · thinking-level · window, e.g. "deepseek-v4-pro · max · 1M".
    // Prefer the resolved model id, falling back to the tier alias when it's
    // absent; the thinking and window segments each drop when unavailable.
    const window = contextWindowSize > 0 ? ` · ${formatTokenCount(contextWindowSize)}` : "";
    const name = banner.modelId ?? banner.model;
    const think = banner.thinkingLabel ? ` · ${banner.thinkingLabel}` : "";
    main.push({ icon: "◆", text: `${name}${think}${window}`, color: "magenta" });
  }
  if (contextWindowSize > 0) {
    const pct = Math.min(100, Math.round((contextTokens / contextWindowSize) * 100));
    main.push({ icon: "○", text: `${contextBar(pct)} ${pct}%`, color: "yellow" });
  }
  if (banner?.cwd) {
    main.push({ icon: "◈", text: basename(banner.cwd) || banner.cwd, color: "green" });
  }
  if (gitBranch) {
    main.push({ icon: "⎇", text: gitBranch, color: "blue" });
  }
  if (banner?.cwd) {
    main.push({ icon: "•", text: displayCwd(banner.cwd, banner.home), color: ACCENT_HEX });
  }

  // Second row: usage — cache hit rate (this session / all-time), session
  // prompt / output token totals, and estimated cost when the model is priced.
  // Each segment gets a distinct color so the row reads like a small dashboard
  // (matching the multi-colored reference statusline) rather than a flat block.
  const usage: StatusSegment[] = [];
  // DeepSeek account balance leads the row (only present when talking to
  // DeepSeek's official API) and is prepended so it survives `fitSegments`
  // dropping rightmost segments first on a narrow terminal. Dimmed to amber
  // when DeepSeek reports the account as unavailable (can't be charged).
  if (accountBalance) {
    usage.push({
      icon: "▰",
      text: `${formatMoney(accountBalance.total, accountBalance.currency)} ${t.status.usageBalance}`,
      color: accountBalance.available ? "green" : "yellow",
    });
  }
  const hitRate = cacheHitRate(cacheReadTokens, cacheCreationTokens, uncachedInputTokens);
  const lifetimeRate = cacheHitRate(
    lifetimeCacheReadTokens,
    lifetimeCacheCreationTokens,
    lifetimeUncachedInputTokens,
  );
  if (hitRate !== null || lifetimeRate !== null) {
    // A geometric glyph (not an emoji like ⚡): emoji render double-width but
    // `visibleWidth` counts them as 1, so the layout would under-reserve space
    // and leave a visible gap after the icon.
    usage.push({ icon: "◆", text: cacheSegmentText(hitRate, lifetimeRate), color: "cyan" });
  }
  const promptTotal = cacheReadTokens + cacheCreationTokens + uncachedInputTokens;
  if (promptTotal > 0) {
    usage.push({ icon: "↑", text: `${formatTokenCount(promptTotal)} ${t.status.usageIn}`, color: "blue" });
  }
  if (sessionOutputTokens > 0) {
    usage.push({
      icon: "↓",
      text: `${formatTokenCount(sessionOutputTokens)} ${t.status.usageOut}`,
      color: "magenta",
    });
  }
  if (costRates && promptTotal + sessionOutputTokens > 0) {
    const cost = computeCost(
      {
        uncachedInputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        outputTokens: sessionOutputTokens,
      },
      costRates,
    );
    usage.push({
      icon: "●",
      // A mid-tone amber hex rather than `yellowBright`: bright yellow is nearly
      // white and washes out on a light terminal background. This amber keeps
      // contrast on both light and dark themes (same tactic as ACCENT_HEX above).
      text: `${formatMoney(cost.total, costRates.currency)} ${t.status.usageCost}`,
      color: "#d97706",
    });
  }

  return (
    <Box flexDirection="column">
      <SegmentRow segments={main} termCols={termCols} />
      <SegmentRow segments={usage} termCols={termCols} />
    </Box>
  );
}
