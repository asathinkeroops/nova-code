import { backoffMs } from "../retry.js";
import { ProviderError, type ProviderErrorInfo } from "./error.js";
import type { AccountBalance, BalanceProbe, ProviderProfile } from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// Error diagnostics
//
// Moonshot (Kimi) exposes an Anthropic-compatible endpoint, so its failures
// arrive through the Anthropic SDK as an `APIError` carrying an HTTP `status`.
// As with DeepSeek, we translate the documented status codes into actionable
// guidance rather than leaking the raw SDK message. This table *is*
// `onError`'s Moonshot-specific content; the shared `ProviderError` (error.ts)
// owns the shape and formatting.
// ────────────────────────────────────────────────────────────────────────────

export const MOONSHOT_DOCS_URL = "https://platform.moonshot.cn/docs/api/error";

/**
 * Moonshot status codes, as provider-neutral {@link ProviderErrorInfo} entries
 * keyed by HTTP status. Anything not here is treated as an unknown Moonshot
 * error and passed through untranslated. 429/500/503 are the transient set the
 * adapter retries on the shared backoff schedule.
 */
const MOONSHOT_ERROR_TABLE: Record<number, ProviderErrorInfo> = {
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
    cause: "The API key is invalid or missing, so authentication failed.",
    remedy: "Check NOVA's apiKey/baseURL, or mint a fresh key, then retry.",
    retryable: false,
    actionUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  403: {
    status: 403,
    title: "Insufficient Balance / Quota",
    cause: "Your Moonshot account is out of balance or over its quota.",
    remedy: "Check your balance and top up, then retry.",
    retryable: false,
    actionUrl: "https://platform.moonshot.cn/console/pay",
  },
  429: {
    status: 429,
    title: "Rate Limit Reached",
    cause: "You hit Moonshot's TPM/RPM concurrency rate limit.",
    remedy:
      "Pace your requests; back off and retry after a short wait, or raise your tier.",
    retryable: true,
  },
  500: {
    status: 500,
    title: "Server Error",
    cause: "Moonshot had an internal server fault.",
    remedy: "Retry after a moment; if it persists, contact Moonshot support.",
    retryable: true,
  },
  503: {
    status: 503,
    title: "Service Unavailable",
    cause: "Moonshot's servers are overloaded.",
    remedy: "Retry later once load subsides.",
    retryable: true,
  },
};

/** Look up the diagnostic for a Moonshot HTTP status, if it's one we document. */
export function describeMoonshotStatus(
  status: number | undefined,
): ProviderErrorInfo | undefined {
  if (status === undefined) return undefined;
  return MOONSHOT_ERROR_TABLE[status];
}

/** Narrow an unknown thrown value to something with an HTTP status field. */
function readStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** Pull Moonshot's own `error.message` out of the SDK error body, if present. */
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
 * code Moonshot documents; return `null` for anything else (aborts, connection
 * failures with status `undefined`, undocumented statuses). The idempotency
 * guard keys off Moonshot's own `provider` id so re-wrapping is a no-op.
 */
export function translateMoonshotError(err: unknown): ProviderError | null {
  if (err instanceof ProviderError && err.provider === "moonshot") return err;
  const info = describeMoonshotStatus(readStatus(err));
  if (!info) return null;
  const detail = readServerDetail(err);
  const retryAfterSeconds = info.retryable ? readRetryAfter(err) : undefined;
  return new ProviderError(
    "moonshot",
    { ...info, docsUrl: MOONSHOT_DOCS_URL },
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
// Moonshot exposes `GET /v1/users/me/balance` (returns amounts in CNY). The
// profile surfaces it via `probeBalance`; the CLI shows the figure on the
// status line. Endpoint lives at the origin root regardless of the
// Anthropic-compat path (`/anthropic`) used for model calls.
// ────────────────────────────────────────────────────────────────────────────

/** Host of Moonshot's official API; the only base URL that exposes the balance endpoint. */
const MOONSHOT_API_HOST = "api.moonshot.cn";

/**
 * Resolve the balance endpoint for a base URL, or null when it's unset or points
 * anywhere other than Moonshot's official host. Exported for tests.
 */
export function moonshotBalanceUrl(baseURL: string | undefined): string | null {
  if (!baseURL) return null;
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return null;
  }
  if (url.host !== MOONSHOT_API_HOST) return null;
  return `${url.origin}/v1/users/me/balance`;
}

// Shape of Moonshot's GET /v1/users/me/balance response. `available_balance` is
// the spendable total (cash + voucher, and may go negative when in arrears);
// top-level `status` is the call's success flag.
interface MoonshotBalanceResponse {
  status: boolean;
  data: { available_balance: number };
}

/** Narrow an untyped JSON body to the balance response, or null if it doesn't fit. */
function parseBalanceResponse(body: unknown): MoonshotBalanceResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.status !== "boolean") return null;
  const data = obj.data;
  if (typeof data !== "object" || data === null) return null;
  const available = (data as Record<string, unknown>).available_balance;
  if (typeof available !== "number") return null;
  return { status: obj.status, data: { available_balance: available } };
}

/**
 * Fetch the Moonshot account balance, or null when not on Moonshot's official
 * API, when no key is set, or on any network/parse error. Best-effort: a 5s
 * timeout keeps a hung request from delaying the caller (always invoked
 * fire-and-forget), and every failure mode collapses to null so the status line
 * simply omits the segment rather than surfacing an error.
 */
async function fetchMoonshotBalance(probe: BalanceProbe): Promise<AccountBalance | null> {
  const endpoint = moonshotBalanceUrl(probe.baseURL);
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
    const total = parsed.data.available_balance;
    return {
      // Moonshot's 国内站 bills in CNY; the endpoint returns no currency field.
      currency: "CNY",
      total,
      available: parsed.status && total > 0,
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

/** True for Moonshot's always-thinking code models (`kimi-k2.7-code` and its
 *  `-highspeed` variant), which force `type:"enabled"` and preserved thinking. */
function isPreservedThinkingModel(model: string): boolean {
  return model.startsWith("kimi-k2.7-code");
}

/**
 * Moonshot's Anthropic-compatible endpoint. The thinking knob is
 * `thinking: { type, keep }` and its accepted shape depends on the model:
 *
 *   - `kimi-k2.7-code` / `-highspeed`: thinking is ALWAYS on and preserved —
 *     the endpoint rejects `type:"disabled"` and treats `keep` as `"all"`. We
 *     always send `{ type: "enabled", keep: "all" }` and ignore the budget.
 *   - `kimi-k2.5` (and other toggle-able Kimi models): `type` switches on the
 *     budget; `keep` is NOT supported and must never be sent.
 *
 * Unlike the generic `budget_tokens` knob there is no `max_tokens` floor (like
 * DeepSeek's effort knob). Documented HTTP failures are translated (see the
 * error table) with 429/500/503 retried on the shared backoff schedule.
 */
export const moonshotProfile: ProviderProfile = {
  id: "moonshot",

  // Matches DeepSeek's ratios: ~0.3 tokens/char for English, ~0.6 for CJK.
  tokenEstimate: { cjk: 0.6, other: 0.3 },

  thinking(budget, model) {
    if (isPreservedThinkingModel(model ?? "")) {
      return { params: { thinking: { type: "enabled", keep: "all" } } };
    }
    if (budget <= 0) return { params: { thinking: { type: "disabled" } } };
    return { params: { thinking: { type: "enabled" } } };
  },

  onError(err, attempt) {
    const api = translateMoonshotError(err);
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
    return fetchMoonshotBalance(probe);
  },
};
