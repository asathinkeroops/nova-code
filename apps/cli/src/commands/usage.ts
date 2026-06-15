import { bold, cyan, dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { cacheHitRate, formatPercent, formatTokenCount } from "../ui/status-format.js";

const TITLE = "/usage";

/**
 * Print this session's cumulative token usage and the prompt-cache hit rate.
 * Counters accumulate per request via the `post_request` hook and reset on
 * `/clear`; the rate is cache reads over all prompt input tokens (read +
 * write + uncached).
 */
export function handleUsage(ctx: CliContext): void {
  const u = ctx.screen.usage();
  const promptTotal = u.cacheReadTokens + u.cacheCreationTokens + u.uncachedInputTokens;
  const rate = cacheHitRate(u.cacheReadTokens, u.cacheCreationTokens, u.uncachedInputTokens);
  if (rate === null) {
    ctx.screen.card(dim("no model requests yet this session."), { title: TITLE });
    return;
  }

  const label = (s: string): string => dim(s.padEnd(16, " "));
  const lines = [
    `${label("cache hit rate")}${bold(cyan(formatPercent(rate)))}  ${dim("(cache read / all prompt tokens)")}`,
    "",
    `${label("prompt tokens")}${formatTokenCount(promptTotal)}`,
    `${label("  cache read")}${formatTokenCount(u.cacheReadTokens)}`,
    `${label("  cache write")}${formatTokenCount(u.cacheCreationTokens)}`,
    `${label("  uncached")}${formatTokenCount(u.uncachedInputTokens)}`,
    `${label("output tokens")}${formatTokenCount(u.outputTokens)}`,
  ];
  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
