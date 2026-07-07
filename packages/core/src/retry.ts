/**
 * Provider-agnostic retry primitives.
 *
 * The exponential-backoff schedule and the "should this even be retried" JSON
 * predicate are not specific to any one provider — a rate limit or a malformed
 * tool-call payload can come from any Anthropic-compatible endpoint — so they
 * live here, in the shared layer, and are consumed both by the model adapter's
 * retry loop and by individual provider profiles.
 */

/**
 * Shared retry budget. `maxAttempts` counts the first try, so 4 means
 * "1 + up to 3 retries".
 */
export const RETRY_LIMITS = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
} as const;

/**
 * Backoff before the next attempt. Honors a server `retry-after` when present;
 * otherwise exponential (base · 2^(failedAttempt−1)). Both are clamped to
 * `maxDelayMs`. `failedAttempt` is 1-based: 1 = first try just failed.
 */
export function backoffMs(failedAttempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) {
    return Math.min(retryAfterSeconds * 1_000, RETRY_LIMITS.maxDelayMs);
  }
  const exp = RETRY_LIMITS.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1);
  return Math.min(exp, RETRY_LIMITS.maxDelayMs);
}

/**
 * Detect the SDK stream-accumulation failure that surfaces when the model emits
 * malformed JSON for a tool call's arguments — a model hiccup any provider can
 * produce (a missing comma between properties, an unterminated value). As the
 * stream closes, the Anthropic SDK parses the accumulated `partial_json` and, on
 * a *structural* error (not mere truncation), rejects `finalMessage()` with an
 * AnthropicError whose message is the underlying JSON `SyntaxError`. There's no
 * HTTP status, so it never becomes a provider API error; we match on the V8
 * parse-error wording instead ("… in JSON at position N", "Unexpected end of
 * JSON input", etc.), checking both the error and its `cause`.
 *
 * Callers treat it as retryable: re-issuing the request almost always yields
 * well-formed JSON (the model samples at non-zero temperature), turning what was
 * a fatal loop termination into a transparent retry.
 */
export function isMalformedToolJsonError(err: unknown): boolean {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    if (err.cause instanceof Error) parts.push(err.cause.message);
  } else {
    parts.push(String(err));
  }
  return /\bin JSON\b|JSON input|JSON at position/i.test(parts.join(" "));
}
