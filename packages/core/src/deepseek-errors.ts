import { detectThinkingFormat } from "./model.js";

/**
 * DeepSeek-specific error diagnostics.
 *
 * DeepSeek's API is Anthropic-compatible on the wire, so its failures arrive
 * through the Anthropic SDK as an `APIError` carrying an HTTP `status`. The raw
 * SDK message for those (`"402 {…}"`) is terse and leaks the raw response body
 * — useless for telling a user their balance ran out vs. their key is wrong.
 * Since this agent is deeply tuned for DeepSeek, we translate the documented
 * status codes into actionable guidance instead.
 *
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/error_codes
 */

export const DEEPSEEK_DOCS_URL =
  "https://api-docs.deepseek.com/zh-cn/quick_start/error_codes";

export interface DeepSeekErrorInfo {
  /** HTTP status as documented by DeepSeek. */
  status: number;
  /** Short English label for the status, e.g. "Insufficient Balance". */
  title: string;
  /** Why it happened. */
  cause: string;
  /** What the operator should do about it. */
  remedy: string;
  /**
   * Whether retrying the same request unchanged could plausibly succeed.
   * Rate limits and server-side faults are transient; auth/balance/validation
   * failures will repeat until the operator fixes something.
   */
  retryable: boolean;
  /** Deep-link to the place the remedy is actually performed, when one exists. */
  actionUrl?: string;
}

/**
 * The seven status codes DeepSeek documents. Keyed by HTTP status. Anything not
 * in here is treated as "unknown DeepSeek error" and passed through untranslated
 * (better to surface the raw SDK message than to invent guidance).
 */
const DEEPSEEK_ERROR_TABLE: Record<number, DeepSeekErrorInfo> = {
  400: {
    status: 400,
    title: "Bad Request",
    cause: "The request body was malformed.",
    remedy: "Fix the request body per the error message and retry.",
    retryable: false,
  },
  401: {
    status: 401,
    title: "Authentication Failure",
    cause: "The API key is wrong, so authentication failed.",
    remedy:
      "Check NOVA's apiKey/baseURL, or mint a fresh key, then retry.",
    retryable: false,
    actionUrl: "https://platform.deepseek.com/api_keys",
  },
  402: {
    status: 402,
    title: "Insufficient Balance",
    cause: "Your DeepSeek account has run out of balance.",
    remedy: "Check your balance and top up, then retry.",
    retryable: false,
    actionUrl: "https://platform.deepseek.com/top_up",
  },
  422: {
    status: 422,
    title: "Invalid Parameters",
    cause: "The request body contains invalid parameters.",
    remedy: "Adjust the parameters per the error message and retry.",
    retryable: false,
  },
  429: {
    status: 429,
    title: "Rate Limit Reached",
    cause: "You hit DeepSeek's TPM or RPM rate limit.",
    remedy:
      "Pace your requests; back off and retry after a short wait, or switch to a higher tier.",
    retryable: true,
  },
  500: {
    status: 500,
    title: "Server Error",
    cause: "DeepSeek had an internal server fault.",
    remedy: "Retry after a moment; if it persists, contact DeepSeek support.",
    retryable: true,
  },
  503: {
    status: 503,
    title: "Service Unavailable",
    cause: "DeepSeek's servers are overloaded.",
    remedy: "Retry later once load subsides.",
    retryable: true,
  },
};

/**
 * Detect the SDK stream-accumulation failure that surfaces when the model emits
 * malformed JSON for a tool call's arguments — a frequent DeepSeek slip (a
 * missing comma between properties, an unterminated value). As the stream
 * closes, the Anthropic SDK parses the accumulated `partial_json` and, on a
 * *structural* error (not mere truncation), rejects `finalMessage()` with an
 * AnthropicError whose message is the underlying JSON `SyntaxError`. There's no
 * HTTP status, so it never becomes a {@link DeepSeekApiError}; we match on the
 * V8 parse-error wording instead ("… in JSON at position N", "Unexpected end of
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
 * Internal retry policy for DeepSeek's *transient* failures (429/500/503) and
 * malformed tool-call JSON. `maxAttempts` counts the first try, so 4 means
 * "1 + up to 3 retries".
 */
export const DEEPSEEK_RETRY = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
} as const;

/**
 * Backoff before the next attempt. Honors a server `retry-after` when present;
 * otherwise exponential (base · 2^(failedAttempt−1)). Both are clamped to
 * `maxDelayMs`. `failedAttempt` is 1-based: 1 = first try just failed.
 */
export function deepSeekRetryDelayMs(
  failedAttempt: number,
  retryAfterSeconds?: number,
): number {
  if (retryAfterSeconds !== undefined) {
    return Math.min(retryAfterSeconds * 1_000, DEEPSEEK_RETRY.maxDelayMs);
  }
  const exp = DEEPSEEK_RETRY.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1);
  return Math.min(exp, DEEPSEEK_RETRY.maxDelayMs);
}

/** Look up the diagnostic for a DeepSeek HTTP status, if it's one we document. */
export function describeDeepSeekStatus(
  status: number | undefined,
): DeepSeekErrorInfo | undefined {
  if (status === undefined) return undefined;
  return DEEPSEEK_ERROR_TABLE[status];
}

/**
 * A DeepSeek API failure translated into actionable guidance. Carries the
 * diagnostic so hooks/UI can react to `retryable` etc., and keeps the original
 * SDK error as `cause` so nothing is lost for logs.
 */
export class DeepSeekApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly info: DeepSeekErrorInfo;
  /** Seconds the server asked us to wait (429 `retry-after`), when provided. */
  readonly retryAfterSeconds?: number;

  constructor(
    info: DeepSeekErrorInfo,
    opts: { cause?: unknown; serverDetail?: string; retryAfterSeconds?: number } = {},
  ) {
    super(formatDeepSeekMessage(info, opts), { cause: opts.cause });
    this.name = "DeepSeekApiError";
    this.status = info.status;
    this.retryable = info.retryable;
    this.info = info;
    if (opts.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = opts.retryAfterSeconds;
    }
  }
}

function formatDeepSeekMessage(
  info: DeepSeekErrorInfo,
  opts: { serverDetail?: string; retryAfterSeconds?: number },
): string {
  const lines = [
    `DeepSeek API ${info.status} — ${info.title}`,
    `Cause: ${info.cause}`,
    `Fix:   ${info.remedy}`,
  ];
  if (info.retryable) {
    const wait =
      opts.retryAfterSeconds !== undefined
        ? ` (server asked to wait ~${opts.retryAfterSeconds}s)`
        : "";
    lines.push(`Retryable: yes${wait}`);
  }
  if (info.actionUrl) lines.push(`Link:  ${info.actionUrl}`);
  if (opts.serverDetail) lines.push(`Detail: ${opts.serverDetail}`);
  lines.push(`Docs:  ${DEEPSEEK_DOCS_URL}`);
  return lines.join("\n");
}

/** Narrow an unknown thrown value to something with an HTTP status field. */
function readStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** Pull DeepSeek's own `error.message` out of the SDK error body, if present. */
function readServerDetail(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const body = (err as { error?: unknown }).error;
  if (typeof body !== "object" || body === null) return undefined;
  const inner = (body as { error?: unknown; message?: unknown }).error ?? body;
  if (typeof inner !== "object" || inner === null) return undefined;
  const msg = (inner as { message?: unknown }).message;
  return typeof msg === "string" && msg.length > 0 ? msg : undefined;
}

/** Read a `retry-after` header (seconds) off the SDK error's headers, if any. */
function readRetryAfter(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const headers = (err as { headers?: unknown }).headers;
  let raw: unknown;
  if (headers instanceof Headers) {
    raw = headers.get("retry-after");
  } else if (typeof headers === "object" && headers !== null) {
    raw = (headers as Record<string, unknown>)["retry-after"];
  }
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Translate a thrown model error into a {@link DeepSeekApiError} when (a) the
 * model is a DeepSeek model and (b) the error carries a status code DeepSeek
 * documents. Otherwise returns the error unchanged — non-DeepSeek models,
 * user aborts and connection failures (status `undefined`), and undocumented
 * statuses all pass straight through.
 */
export function translateDeepSeekError(err: unknown, model: string): unknown {
  if (detectThinkingFormat(model) !== "deepseek") return err;
  if (err instanceof DeepSeekApiError) return err;
  const info = describeDeepSeekStatus(readStatus(err));
  if (!info) return err;
  const serverDetail = readServerDetail(err);
  const retryAfterSeconds = info.retryable ? readRetryAfter(err) : undefined;
  return new DeepSeekApiError(info, {
    cause: err,
    ...(serverDetail ? { serverDetail } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}
