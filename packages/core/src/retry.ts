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
 * Shared retry budget. `maxAttempts` counts the first try, so 10 means
 * "1 + up to 9 retries".
 */
export const RETRY_LIMITS = {
  maxAttempts: 10,
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

/**
 * Node/undici error `code`s for a dropped or refused connection — the transport
 * failed before or during the response, independent of any provider. These reach
 * us from the streaming fetch (a gateway resetting a long-lived socket, a DNS
 * blip, a refused connect) with no HTTP `status`, so provider status tables never
 * classify them.
 */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * Message fragments for the same class of transport failures when the code is
 * lost through wrapping (undici surfaces `TypeError: terminated` / `fetch
 * failed`; the Anthropic SDK wraps connect failures as `APIConnectionError` with
 * the message "Connection error."). Deliberately narrow so a genuine model/API
 * message never matches — and it excludes user aborts, which the adapter guards
 * separately via the abort signal.
 */
const TRANSIENT_NETWORK_MESSAGE =
  /\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEPIPE\b|socket hang up|other side closed|premature close|network socket disconnected|\bterminated\b|fetch failed|Connection error|Request timed out/i;

/**
 * Detect a transient network/transport failure worth retrying. Walks the `cause`
 * chain (undici and the Anthropic SDK both nest the original socket error a level
 * or two down) checking each link's `code` against {@link TRANSIENT_NETWORK_CODES}
 * and its `message` against {@link TRANSIENT_NETWORK_MESSAGE}.
 *
 * Callers treat it as retryable: a reset socket almost always succeeds on a
 * re-issue, so re-running the request turns a one-off blip — which otherwise
 * kills the whole turn (or a sub-agent) — into a transparent retry. The adapter
 * still gates on the abort signal, so a user cancel is never mistaken for one.
 */
export function isTransientNetworkError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (typeof cur === "string") return TRANSIENT_NETWORK_MESSAGE.test(cur);
    if (typeof cur !== "object") return false;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
    const message = (cur as { message?: unknown }).message;
    if (typeof message === "string" && TRANSIENT_NETWORK_MESSAGE.test(message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
