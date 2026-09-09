/**
 * Measures how fast one model request produced output tokens, for the
 * StatusLine's `tok/s` segment.
 *
 * The window runs from the first streamed chunk carrying output to the last
 * one, deliberately excluding prompt upload and time-to-first-token so the
 * number reads as generation speed rather than end-to-end latency. The token
 * count is the transport's live estimate while streaming (the spinner shows the
 * same one) and is settled with the authoritative usage figure on
 * {@link OutputRateTracker.finish}, so the live and final values stay close.
 *
 * The tracker is per request: `finish` (or `reset`) must be called at
 * `post_request` before the next request feeds it, or the previous request's
 * window would be extended into the new one.
 */

/**
 * Shortest window a rate is reported over. Two chunks 20ms apart would
 * otherwise divide a tiny token count into a four-digit number; below this
 * `finish` falls back to the request's own duration, which includes
 * time-to-first-token — a deliberately softer figure for a fast tiny answer.
 */
const MIN_WINDOW_MS = 400;

export interface OutputRateTracker {
  /** Record the cumulative output-token count as it streams. */
  onProgress(outputTokens: number, now: number): void;
  /**
   * Average over the streaming window so far, or null while it is too young to
   * divide by (the caller should keep showing the previous rate).
   */
  liveRate(): number | null;
  /**
   * Settle the request with the authoritative output-token count and its total
   * duration, then reset for the next one. Returns tokens/second, or null when
   * the request produced no output or no usable timing.
   */
  finish(outputTokens: number, durationMs: number): number | null;
  /** Drop the current window without reporting (failed / aborted request). */
  reset(): void;
}

export function createOutputRateTracker(): OutputRateTracker {
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let tokens = 0;

  const rate = (count: number, windowMs: number): number | null =>
    count > 0 && windowMs > 0 ? (count / windowMs) * 1000 : null;

  const reset = (): void => {
    firstAt = null;
    lastAt = null;
    tokens = 0;
  };

  return {
    onProgress(outputTokens, now) {
      // Zero-output chunks (the `message_start` prompt count) carry no timing
      // information — letting one set `firstAt` would start the window before
      // the model produced anything.
      if (outputTokens <= 0) return;
      if (firstAt === null) firstAt = now;
      lastAt = now;
      tokens = outputTokens;
    },

    liveRate() {
      if (firstAt === null || lastAt === null) return null;
      if (lastAt - firstAt < MIN_WINDOW_MS) return null;
      return rate(tokens, lastAt - firstAt);
    },

    finish(outputTokens, durationMs) {
      const windowMs = firstAt !== null && lastAt !== null ? lastAt - firstAt : 0;
      const settled =
        windowMs >= MIN_WINDOW_MS ? rate(outputTokens, windowMs) : rate(outputTokens, durationMs);
      reset();
      return settled;
    },

    reset,
  };
}
