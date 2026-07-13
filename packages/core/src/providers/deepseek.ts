import { backoffMs } from "../retry.js";
import { THINKING_BUDGETS } from "../thinking.js";
import { ProviderError, type ProviderErrorInfo } from "./error.js";
import type { AccountBalance, BalanceProbe, ProviderProfile } from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// Error diagnostics
//
// DeepSeek's API is Anthropic-compatible on the wire, so its failures arrive
// through the Anthropic SDK as an `APIError` carrying an HTTP `status`. The raw
// SDK message for those (`"402 {…}"`) is terse and leaks the raw response body
// — useless for telling a user their balance ran out vs. their key is wrong.
// Since this agent is deeply tuned for DeepSeek, we translate the documented
// status codes into actionable guidance instead. This is just data + a lookup:
// the shared `ProviderError` (see error.ts) owns the shape and formatting, and
// this table *is* `onError`'s DeepSeek-specific content.
//
// Source: https://api-docs.deepseek.com/zh-cn/quick_start/error_codes
// ────────────────────────────────────────────────────────────────────────────

export const DEEPSEEK_DOCS_URL =
  "https://api-docs.deepseek.com/zh-cn/quick_start/error_codes";

/**
 * The seven status codes DeepSeek documents, as provider-neutral
 * {@link ProviderErrorInfo} entries keyed by HTTP status. Anything not in here is
 * treated as "unknown DeepSeek error" and passed through untranslated (better to
 * surface the raw SDK message than to invent guidance).
 */
const DEEPSEEK_ERROR_TABLE: Record<number, ProviderErrorInfo> = {
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
    remedy: "Check NOVA's apiKey/baseURL, or mint a fresh key, then retry.",
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

/** Look up the diagnostic for a DeepSeek HTTP status, if it's one we document. */
export function describeDeepSeekStatus(
  status: number | undefined,
): ProviderErrorInfo | undefined {
  if (status === undefined) return undefined;
  return DEEPSEEK_ERROR_TABLE[status];
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
 * Wrap a thrown model error into a {@link ProviderError} when it carries a status
 * code DeepSeek documents; return `null` for anything else (user aborts and
 * connection failures with status `undefined`, undocumented statuses). The caller
 * (`deepseekProfile.onError`) already knows the model is a DeepSeek model, so
 * there is no model-name gate here. The idempotency guard keys off DeepSeek's own
 * `provider` id so re-wrapping a translated DeepSeek error is a no-op.
 */
export function translateDeepSeekError(err: unknown): ProviderError | null {
  if (err instanceof ProviderError && err.provider === "deepseek") return err;
  const info = describeDeepSeekStatus(readStatus(err));
  if (!info) return null;
  const detail = readServerDetail(err);
  const retryAfterSeconds = info.retryable ? readRetryAfter(err) : undefined;
  return new ProviderError(
    "deepseek",
    { ...info, docsUrl: DEEPSEEK_DOCS_URL },
    {
      cause: err,
      ...(detail ? { detail } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    },
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Account balance
//
// DeepSeek's official API exposes a `/user/balance` endpoint no other provider
// has. The profile surfaces it via `probeBalance`; the CLI shows the figure on
// the status line and simply omits the segment for providers without the hook.
// ────────────────────────────────────────────────────────────────────────────

/** Host of DeepSeek's official API; the only base URL that exposes `/user/balance`. */
const DEEPSEEK_API_HOST = "api.deepseek.com";

/**
 * Resolve the balance endpoint for a base URL, or null when it's unset or points
 * anywhere other than DeepSeek's official host. The endpoint lives at the origin
 * root (`/user/balance`) regardless of the Anthropic-compat path (`/anthropic`)
 * used for model calls. Exported for tests.
 */
export function deepseekBalanceUrl(baseURL: string | undefined): string | null {
  if (!baseURL) return null;
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return null;
  }
  if (url.host !== DEEPSEEK_API_HOST) return null;
  return `${url.origin}/user/balance`;
}

// Shape of DeepSeek's GET /user/balance response. Amounts arrive as strings.
interface BalanceInfo {
  currency: AccountBalance["currency"];
  total_balance: string;
}
interface BalanceResponse {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

/** Narrow an untyped JSON body to the balance response, or null if it doesn't fit. */
function parseBalanceResponse(body: unknown): BalanceResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.is_available !== "boolean" || !Array.isArray(obj.balance_infos)) return null;
  const infos: BalanceInfo[] = [];
  for (const raw of obj.balance_infos) {
    if (typeof raw !== "object" || raw === null) continue;
    const info = raw as Record<string, unknown>;
    if (
      (info.currency === "USD" || info.currency === "CNY") &&
      typeof info.total_balance === "string"
    ) {
      infos.push({ currency: info.currency, total_balance: info.total_balance });
    }
  }
  return { is_available: obj.is_available, balance_infos: infos };
}

/**
 * Fetch the DeepSeek account balance, or null when not on DeepSeek's official
 * API, when no key is set, or on any network/parse error. Best-effort: a 5s
 * timeout keeps a hung request from delaying the caller (always invoked
 * fire-and-forget), and every failure mode collapses to null so the status line
 * simply omits the segment rather than surfacing an error.
 */
async function fetchDeepSeekBalance(probe: BalanceProbe): Promise<AccountBalance | null> {
  const endpoint = deepseekBalanceUrl(probe.baseURL);
  if (!endpoint || !probe.apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${probe.apiKey}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const parsed = parseBalanceResponse(await res.json());
    if (!parsed) return null;

    // DeepSeek returns one entry per currency; show the first (typically the
    // account's billing currency).
    const info = parsed.balance_infos[0];
    if (!info) return null;
    return {
      currency: info.currency,
      total: Number.parseFloat(info.total_balance) || 0,
      available: parsed.is_available,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Provider profile
// ────────────────────────────────────────────────────────────────────────────

// DeepSeek only exposes "high" and "max". Anything below our `max` budget
// (32k tokens, see THINKING_BUDGETS) rounds to "high"; at-or-above rounds to
// "max" — matches DeepSeek's documented behavior where low/medium are
// rewritten to high on their side.
function budgetToEffort(budget: number): "high" | "max" {
  return budget >= THINKING_BUDGETS.max ? "max" : "high";
}

/**
 * DeepSeek's Anthropic-compatible endpoint. Takes thinking intensity via
 * `output_config.effort` (it rejects `budget_tokens`), and its documented HTTP
 * failures are translated into actionable diagnostics (see the error table
 * above) with transient statuses retried on the shared backoff schedule.
 */
export const deepseekProfile: ProviderProfile = {
  id: "deepseek",

  thinking(budget) {
    if (budget <= 0) return { params: { thinking: { type: "disabled" } } };
    return {
      params: {
        thinking: { type: "enabled" },
        output_config: { effort: budgetToEffort(budget) },
      },
    };
  },

  onError(err, attempt) {
    const api = translateDeepSeekError(err);
    // Undocumented status / abort / connection failure: pass the raw error
    // through untranslated rather than inventing guidance.
    if (!api) return { retry: false, error: err };
    if (api.retryable) {
      return {
        retry: true,
        delayMs: backoffMs(attempt, api.retryAfterSeconds),
        error: api,
      };
    }
    return { retry: false, error: api };
  },

  probeBalance(probe) {
    return fetchDeepSeekBalance(probe);
  },
};
