import { computeThreshold, estimateTokens, sliceFromLastCompacted } from "@nova/context";
import { resolveProfile } from "@nova/core";
import { resolveContextWindowSize } from "@nova/runtime";
import { accent, ACCENT_HEX, blue, bold, cyan, dim, green, yellow, magenta } from "../colors.js";
import type { CliContext } from "../context.js";
import { measureFixedOverhead } from "../context-usage.js";
import { t } from "../i18n/index.js";
import { contextBar, formatPercent, formatTokenCount } from "../ui/status-format.js";

const TITLE = "/context";

interface Row {
  label: string;
  tokens: number;
  /** Colorizer for the row's leading block + token figure. */
  color: (s: string) => string;
  /** Drop the row when its token count is 0 (optional/empty categories). */
  hideWhenEmpty?: boolean;
}

/**
 * Visualize what currently occupies the model's context window, broken out by
 * category — system prompt, memory, skills, tool schemas, MCP tools, and the
 * conversation — against the active model tier's window. Unlike `/usage` (which
 * reports cumulative per-session token spend), this is a live snapshot of the
 * NEXT request's prompt: every figure is re-derived from the current message
 * buffer, tool registry, and memory bundle using the same ~4-chars/token
 * estimate the auto-compactor uses. When auto-compact is enabled, the window is
 * split into usable space (up to the compaction threshold) and a reserved
 * "autocompact buffer" above it.
 */
export async function handleContext(ctx: CliContext): Promise<void> {
  const windowTokens = resolveContextWindowSize(ctx.settings, ctx.settings.model);

  // Weight the estimate by the active provider's tokenizer ratios (CJK vs. rest)
  // so the breakdown matches what `shouldAutoCompact` triggers on.
  const weights = resolveProfile(ctx.settings.provider).tokenEstimate;

  // The non-conversation part of the request, measured by the SAME helper the
  // auto-compaction trigger uses — the panel and the trigger have to agree on
  // what fills the window, or the gauge lies about when compaction fires.
  const { systemTokens, memoryTokens, skillsTokens, toolsTokens, mcpTokens } =
    measureFixedOverhead(ctx, weights);

  // The model only receives the slice from the last <compacted> boundary; the
  // retained pre-boundary history stays on disk / in the TUI but costs no
  // context window. Measure the slice so the gauge and auto-compact buffer math
  // match what is actually sent (and what shouldAutoCompact triggers on).
  const messagesTokens = estimateTokens(sliceFromLastCompacted(ctx.screen.getMessages()), weights);

  const used =
    systemTokens + memoryTokens + skillsTokens + toolsTokens + mcpTokens + messagesTokens;

  // Auto-compact reserves the slice of the window above its trigger threshold;
  // free space is what remains below it. With auto-compact off, the whole
  // window is usable and there is no reserved buffer.
  const auto = ctx.settings.compact.auto;
  const threshold = auto.enabled
    ? computeThreshold({
        contextWindowSize: windowTokens,
        thresholdTokens: auto.thresholdTokens,
        contextWindowPercent: auto.contextWindowPercent,
      })
    : windowTokens;
  const autocompactBuffer = Math.max(0, windowTokens - threshold);
  const freeSpace = Math.max(0, threshold - used);

  const rows: Row[] = [
    { label: t.contextView.labelSystemPrompt, tokens: systemTokens, color: blue },
    { label: t.contextView.labelMemoryFiles, tokens: memoryTokens, color: green, hideWhenEmpty: true },
    { label: t.contextView.labelSkills, tokens: skillsTokens, color: yellow, hideWhenEmpty: true },
    { label: t.contextView.labelTools, tokens: toolsTokens, color: cyan },
    { label: t.contextView.labelMcpTools, tokens: mcpTokens, color: magenta, hideWhenEmpty: true },
    { label: t.contextView.labelMessages, tokens: messagesTokens, color: accent },
    { label: t.contextView.labelFreeSpace, tokens: freeSpace, color: dim },
    {
      label: t.contextView.labelAutocompactBuffer,
      tokens: autocompactBuffer,
      color: dim,
      hideWhenEmpty: true,
    },
  ];

  const pad = (s: string): string => dim(s.padEnd(20, " "));
  const pct = (n: number): string =>
    windowTokens > 0 ? dim(formatPercent(n / windowTokens).padStart(4, " ")) : "";

  const usedPercent = windowTokens > 0 ? (used / windowTokens) * 100 : 0;
  const lines: string[] = [
    `${accent(contextBar(usedPercent, 28))}  ${bold(cyan(formatPercent(used / Math.max(1, windowTokens))))}  ${dim(
      `(${formatTokenCount(used)} / ${formatTokenCount(windowTokens)} · ${ctx.settings.model})`,
    )}`,
    "",
  ];

  for (const r of rows) {
    if (r.hideWhenEmpty && r.tokens === 0) continue;
    lines.push(
      `${r.color("█")} ${pad(r.label)}${formatTokenCount(r.tokens).padEnd(8, " ")}${pct(r.tokens)}`,
    );
  }

  await ctx.screen.viewer({
    lines,
    header: `${accent(TITLE)}  ${dim(ctx.settings.model)}`,
    footer: dim(t.common.footerScrollClose),
    pageSize: 24,
    border: false,
    topRuleColor: ACCENT_HEX,
  });
}
