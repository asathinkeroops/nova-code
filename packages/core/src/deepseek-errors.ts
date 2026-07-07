import { RETRY_LIMITS, backoffMs, isMalformedToolJsonError } from "./retry.js";

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

// Malformed tool-call JSON is a model hiccup any provider can produce, so its
// detection lives in the shared retry layer. Re-exported here for back-compat
// (and this module's own tests), and used by the DeepSeek profile.
export { isMalformedToolJsonError } from "./retry.js";

/**
 * DeepSeek's retry policy is just the shared retry budget — its *transient*
 * failures (429/500/503) and malformed tool-call JSON both back off on the same
 * schedule. Aliased (not redefined) so there is a single source of truth.
 */
export const DEEPSEEK_RETRY = RETRY_LIMITS;

/** Backoff before the next attempt — the shared exponential/`retry-after` schedule. */
export const deepSeekRetryDelayMs = backoffMs;

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
 * Wrap a thrown model error into a {@link DeepSeekApiError} when it carries a
 * status code DeepSeek documents; return `null` for anything else (user aborts
 * and connection failures with status `undefined`, undocumented statuses). This
 * is the *un-gated* core — it does NOT check whether the model is a DeepSeek
 * model, because its only callers already know it is (the DeepSeek provider
 * profile, and the gated {@link translateDeepSeekError} below).
 */
export function toDeepSeekApiError(err: unknown): DeepSeekApiError | null {
  if (err instanceof DeepSeekApiError) return err;
  const info = describeDeepSeekStatus(readStatus(err));
  if (!info) return null;
  const serverDetail = readServerDetail(err);
  const retryAfterSeconds = info.retryable ? readRetryAfter(err) : undefined;
  return new DeepSeekApiError(info, {
    cause: err,
    ...(serverDetail ? { serverDetail } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

/**
 * Translate a thrown model error into a {@link DeepSeekApiError} when (a) the
 * model is a DeepSeek model and (b) the error carries a status code DeepSeek
 * documents. Otherwise returns the error unchanged. Retained for back-compat;
 * the provider profile calls {@link toDeepSeekApiError} directly.
 */
export function translateDeepSeekError(err: unknown, model: string): unknown {
  if (!/deepseek/i.test(model)) return err;
  return toDeepSeekApiError(err) ?? err;
}
