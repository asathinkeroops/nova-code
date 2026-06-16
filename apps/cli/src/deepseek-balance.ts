import type { Currency } from "@nova/observability";
import type { Settings } from "@nova/runtime";

/**
 * DeepSeek account balance, surfaced on the StatusLine's second row when the
 * agent talks directly to DeepSeek's official API. Only meaningful for that one
 * provider — the `/user/balance` endpoint is DeepSeek-specific — so it is gated
 * on the configured base URL pointing at `api.deepseek.com` and stays hidden
 * for Anthropic / proxy / aggregator endpoints.
 */
export interface AccountBalance {
  /** Currency the figures are denominated in (DeepSeek bills in CNY or USD). */
  currency: Currency;
  /** Total spendable balance (granted + topped-up) in `currency`. */
  total: number;
  /** DeepSeek's `is_available` flag — false when the account can't be charged. */
  available: boolean;
}

/** Host of DeepSeek's official API; the only base URL that exposes `/user/balance`. */
const DEEPSEEK_API_HOST = "api.deepseek.com";

/**
 * Resolve the balance endpoint for the active settings, or null when the base
 * URL is unset or points anywhere other than DeepSeek's official host. The
 * endpoint lives at the origin root (`/user/balance`) regardless of the
 * Anthropic-compat path (`/anthropic`) used for the model calls.
 */
export function deepseekBalanceUrl(settings: Settings): string | null {
  if (!settings.baseURL) return null;
  let url: URL;
  try {
    url = new URL(settings.baseURL);
  } catch {
    return null;
  }
  if (url.host !== DEEPSEEK_API_HOST) return null;
  return `${url.origin}/user/balance`;
}

// Shape of DeepSeek's GET /user/balance response. Amounts arrive as strings.
interface BalanceInfo {
  currency: Currency;
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
 * fire-and-forget), and every failure mode collapses to null so the StatusLine
 * simply omits the segment rather than surfacing an error.
 */
export async function fetchDeepSeekBalance(settings: Settings): Promise<AccountBalance | null> {
  const endpoint = deepseekBalanceUrl(settings);
  if (!endpoint || !settings.apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
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
