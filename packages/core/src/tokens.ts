import type { TokenEstimate } from "./providers/types.js";

/**
 * Tokenizer-free token estimation. Nova doesn't ship a real tokenizer, so it
 * approximates token counts from character counts, weighting CJK characters
 * (which pack fewer chars per token) differently from everything else. The
 * per-script weights are a property of the active provider's tokenizer and
 * live on its {@link import("./providers/types.js").ProviderProfile} as a
 * {@link TokenEstimate}; this module owns the shared *counting*, so the ranges
 * and the arithmetic exist in exactly one place (used by both the live
 * streaming counter in `model.ts` and the compaction/`/context` estimators in
 * `@nova/context` and the CLI).
 */

/**
 * A neutral default used where no profile is threaded through (function-default
 * fallbacks, tests). Matches DeepSeek's documented ~0.3 tokens/char for Latin
 * and ~0.6 for CJK; close enough for generic Anthropic-compatible endpoints too
 * (English there also runs ~0.27–0.3 tokens/char). Real callers pass the active
 * profile's `tokenEstimate` instead of relying on this.
 */
export const DEFAULT_TOKEN_ESTIMATE: TokenEstimate = { cjk: 0.6, other: 0.3 };

/**
 * Whether a Unicode code point is a CJK ideograph, Japanese kana, or Korean
 * hangul syllable — the scripts that tokenize at a heavier chars→tokens ratio.
 * The single source of truth for the ranges (shared by the streaming counter
 * and the string estimator).
 */
export function isCjkCodePoint(c: number): boolean {
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // CJK ideographs
    (c >= 0x3040 && c <= 0x30ff) || // kana
    (c >= 0xac00 && c <= 0xd7a3) // hangul
  );
}

/**
 * Estimate the token count of `text` by weighting CJK vs. non-CJK characters
 * per `weights`. A rough, single-pass approximation — not a real tokenizer.
 */
export function estimateTextTokens(
  text: string,
  weights: TokenEstimate = DEFAULT_TOKEN_ESTIMATE,
): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * weights.cjk + other * weights.other);
}
