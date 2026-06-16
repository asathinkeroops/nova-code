import {
  computeCost,
  formatMoney,
  resolveModelRates,
  type ModelPrice,
  type ModelRates,
} from "@nova/observability";
import { DEFAULT_MODEL_PRICING } from "@nova/runtime";
import { bold, cyan, dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { cacheHitRate, formatPercent, formatTokenCount } from "../ui/status-format.js";

const TITLE = "/usage";

/**
 * Build the effective price table: the user's `pricing.models` first (so they
 * override) then the built-in defaults. Entries omitting cache rates fall back
 * to the uncached `input` rate.
 */
function priceTable(ctx: CliContext): ModelPrice[] {
  return [...ctx.settings.pricing.models, ...DEFAULT_MODEL_PRICING].map((p) => ({
    match: p.match,
    input: p.input,
    output: p.output,
    cacheRead: p.cacheRead ?? p.input,
    cacheWrite: p.cacheWrite ?? p.input,
    currency: p.currency,
  }));
}

/**
 * Resolve the active model's per-token rates from the effective price table, or
 * undefined when pricing is disabled or the model has no matching entry. Shared
 * by `/usage` and the StatusLine cost segment so both price the same way.
 */
export function resolveSessionRates(ctx: CliContext): ModelRates | undefined {
  if (!ctx.settings.pricing.enabled) return undefined;
  return resolveModelRates(ctx.settings.model, priceTable(ctx));
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
export function handleUsage(ctx: CliContext): void {
  const u = ctx.screen.usage();
  const promptTotal = u.cacheReadTokens + u.cacheCreationTokens + u.uncachedInputTokens;
  const rate = cacheHitRate(u.cacheReadTokens, u.cacheCreationTokens, u.uncachedInputTokens);
  if (rate === null) {
    ctx.screen.card(dim("no model requests yet this session."), { title: TITLE });
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
      `${label("cost (est.)")}${dim(`no price for "${ctx.settings.model}" — add it to pricing.models in nova.config.json`)}`,
    );
  }

  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
