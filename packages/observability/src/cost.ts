/**
 * Cost accounting: turn cumulative token counts into money amounts using
 * per-model rates. Pure and dependency-free — the price table and the
 * user-facing config live in @nova/runtime; this module only does the
 * arithmetic and the model→rate lookup, so it stays a leaf the CLI (and any
 * future reporter) can reuse without pulling in settings.
 */

/**
 * Display currency for a price entry. Rates are plain numbers per 1M tokens;
 * this only selects the symbol shown to the user — there is no FX conversion,
 * so all rates within a single entry are in that entry's currency. DeepSeek's
 * v4 models list-price in CNY, the Claude / older DeepSeek defaults in USD.
 */
export type Currency = "USD" | "CNY";

const CURRENCY_SYMBOL: Record<Currency, string> = { USD: "$", CNY: "¥" };

/** Price per 1,000,000 tokens, split by token bucket. */
export interface ModelRates {
  /** Uncached prompt input tokens. */
  input: number;
  /** Output (completion) tokens. */
  output: number;
  /** Cache-read prompt tokens (a prefix served from the provider cache). */
  cacheRead: number;
  /** Cache-creation prompt tokens (writing a new prefix into the cache). */
  cacheWrite: number;
  /** Currency the rates are denominated in; defaults to USD when omitted. */
  currency?: Currency;
}

/** Cumulative token counts to price, in the same buckets `/usage` tracks. */
export interface TokenCounts {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

/** A per-bucket cost breakdown plus the total, all in USD. */
export interface CostBreakdown {
  /** Uncached input tokens. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
}

const PER_MILLION = 1_000_000;

/**
 * Price `counts` with `rates`. Each bucket is `tokens / 1e6 * ratePerMillion`;
 * the total is their sum. Counts and rates are both non-negative, so every
 * field of the result is too.
 */
export function computeCost(counts: TokenCounts, rates: ModelRates): CostBreakdown {
  const input = (counts.uncachedInputTokens / PER_MILLION) * rates.input;
  const cacheRead = (counts.cacheReadTokens / PER_MILLION) * rates.cacheRead;
  const cacheWrite = (counts.cacheCreationTokens / PER_MILLION) * rates.cacheWrite;
  const output = (counts.outputTokens / PER_MILLION) * rates.output;
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    total: input + cacheRead + cacheWrite + output,
  };
}

/**
 * Format a money amount for display in `currency` (default USD). Sub-cent
 * amounts get four decimals (so a fraction-of-a-cent request reads as
 * "$0.0003" instead of a misleading "$0.00"); everything else gets the usual
 * two. Negatives are clamped to 0.
 */
export function formatMoney(amount: number, currency: Currency = "USD"): string {
  const sym = CURRENCY_SYMBOL[currency];
  const v = Math.max(0, amount);
  if (v > 0 && v < 0.01) return `${sym}${v.toFixed(4)}`;
  return `${sym}${v.toFixed(2)}`;
}
