import { activeModels, computeCost, formatMoney, type ModelRates } from "@nova/base";
import { accent, ACCENT_HEX, bold, cyan, dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import { cacheHitRate, formatPercent, formatTokenCount } from "../ui/status-format.js";

const TITLE = "/usage";

/**
 * Resolve the active model tier's per-token rates from its own `pricing` block,
 * or undefined when pricing is disabled or the tier carries no `pricing`. Cache
 * rates omitted on the tier fall back to the uncached `input` rate. Shared by
 * `/usage` and the StatusLine cost segment so both price the same way.
 */
export function resolveSessionRates(ctx: CliContext): ModelRates | undefined {
  if (!ctx.settings.pricing.enabled) return undefined;
  const p = activeModels(ctx.settings)[ctx.settings.model]?.pricing;
  if (!p) return undefined;
  return {
    input: p.input,
    output: p.output,
    cacheRead: p.cacheRead ?? p.input,
    cacheWrite: p.cacheWrite ?? p.input,
    currency: p.currency,
  };
}

/**
 * Print this session's cumulative token usage, the prompt-cache hit rate, and
 * — when the active model has a known price — an estimated dollar cost broken
 * out per token bucket. Counters accumulate per request via the `post_request`
 * hook and reset on `/clear`; the rate is cache reads over all prompt input
 * tokens (read + write + uncached). Pricing comes from `settings.pricing`
 * (user `models` overriding the built-in table); an unpriced model shows tokens
 * only.
 */
export async function handleUsage(ctx: CliContext): Promise<void> {
  const u = ctx.screen.usage();
  const promptTotal = u.cacheReadTokens + u.cacheCreationTokens + u.uncachedInputTokens;
  const rate = cacheHitRate(u.cacheReadTokens, u.cacheCreationTokens, u.uncachedInputTokens);
  if (rate === null) {
    await ctx.screen.viewer({
      lines: [dim(t.usage.noRequests)],
      header: `${accent(TITLE)}  ${dim(ctx.settings.model)}`,
      footer: dim(t.common.footerClose),
      border: false,
      topRuleColor: ACCENT_HEX,
    });
    return;
  }

  const pricing = ctx.settings.pricing;
  const rates = resolveSessionRates(ctx);
  const cost = rates
    ? computeCost(
        {
          uncachedInputTokens: u.uncachedInputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheCreationTokens: u.cacheCreationTokens,
          outputTokens: u.outputTokens,
        },
        rates,
      )
    : null;

  const label = (s: string): string => dim(s.padEnd(16, " "));
  // Pad the token magnitude so the trailing cost column lines up across rows.
  const tok = (n: number): string => formatTokenCount(n).padEnd(8, " ");
  const money = (v: number | undefined): string =>
    v === undefined ? "" : dim(formatMoney(v, rates?.currency));

  const lines = [
    `${label(t.usage.cacheHitRate)}${bold(cyan(formatPercent(rate)))}  ${dim(t.usage.cacheHitRateHint)}`,
    "",
    `${label(t.usage.promptTokens)}${formatTokenCount(promptTotal)}`,
    `${label(t.usage.cacheRead)}${tok(u.cacheReadTokens)}${money(cost?.cacheRead)}`,
    `${label(t.usage.cacheWrite)}${tok(u.cacheCreationTokens)}${money(cost?.cacheWrite)}`,
    `${label(t.usage.uncached)}${tok(u.uncachedInputTokens)}${money(cost?.input)}`,
    `${label(t.usage.outputTokens)}${tok(u.outputTokens)}${money(cost?.output)}`,
  ];

  if (cost) {
    lines.push(
      "",
      `${label(t.usage.costEst)}${bold(cyan(formatMoney(cost.total, rates?.currency)))}  ${dim(ctx.settings.model)}`,
    );
  } else if (pricing.enabled) {
    lines.push(
      "",
      `${label(t.usage.costEst)}${dim(t.usage.noPrice(ctx.settings.model))}`,
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
