import { computeCost, formatMoney, type ModelRates } from "@nova/observability";
import { accent, bold, cyan, dim, PURPLE_HEX } from "../colors.js";
import type { CliContext } from "../context.js";
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
  const p = ctx.settings.models[ctx.settings.model]?.pricing;
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
      lines: [dim("no model requests yet this session.")],
      header: `${accent(TITLE)}  ${dim(ctx.settings.model)}`,
      footer: dim("enter/esc/q close"),
      border: false,
      topRuleColor: PURPLE_HEX,
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
    `${label("cache hit rate")}${bold(cyan(formatPercent(rate)))}  ${dim("(cache read / all prompt tokens)")}`,
    "",
    `${label("prompt tokens")}${formatTokenCount(promptTotal)}`,
    `${label("  cache read")}${tok(u.cacheReadTokens)}${money(cost?.cacheRead)}`,
    `${label("  cache write")}${tok(u.cacheCreationTokens)}${money(cost?.cacheWrite)}`,
    `${label("  uncached")}${tok(u.uncachedInputTokens)}${money(cost?.input)}`,
    `${label("output tokens")}${tok(u.outputTokens)}${money(cost?.output)}`,
  ];

  if (cost) {
    lines.push(
      "",
      `${label("cost (est.)")}${bold(cyan(formatMoney(cost.total, rates?.currency)))}  ${dim(ctx.settings.model)}`,
    );
  } else if (pricing.enabled) {
    lines.push(
      "",
      `${label("cost (est.)")}${dim(`no price for "${ctx.settings.model}" — add "pricing" to that model tier in nova.config.json`)}`,
    );
  }

  await ctx.screen.viewer({
    lines,
    header: `${accent(TITLE)}  ${dim(ctx.settings.model)}`,
    footer: dim("↑↓ scroll · enter/esc/q close"),
    pageSize: 24,
    border: false,
    topRuleColor: PURPLE_HEX,
  });
}
