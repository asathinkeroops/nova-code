/**
 * A provider profile bundles everything the model adapter needs to know that
 * differs between LLM providers — the thinking-knob wire shape and how to react
 * to a failed request — behind one interface. The adapter (`model.ts`) depends
 * only on this shape and never on a concrete provider, so adding a provider is
 * adding a file that implements this interface plus one line in the `PROVIDERS`
 * registry (`index.ts`) — no hot-path edit, and no id union to widen (the `id`
 * field is `string`, and `ProviderId` derives from the registry keys).
 *
 * All providers here speak the Anthropic-compatible wire format (they go through
 * the same `@anthropic-ai/sdk` client); a profile only captures the *quirks* on
 * top of that, not a whole alternate transport.
 */

import type { ProviderError } from "./error.js";

/** Wire params for the thinking knob, plus any `max_tokens` floor the format imposes. */
export interface ThinkingParams {
  /** Fields merged verbatim into the request body (e.g. `thinking`, `output_config`). */
  params: Record<string, unknown>;
  /**
   * Minimum `max_tokens` this thinking config requires, if any. Anthropic needs
   * `max_tokens > budget_tokens`; the adapter bumps `max_tokens` to at least
   * this. Omitted when the format imposes no floor (e.g. DeepSeek's effort knob).
   */
  minMaxTokens?: number;
}

/**
 * The verdict on a failed request: either retry after `delayMs`, or give up and
 * throw `error`. A retry is only ever offered for a failure the profile *classified*,
 * so its `error` is always a translated {@link ProviderError} (the adapter reads
 * `error.status` for the retry notice — no separate `status` field to keep in sync).
 * The give-up arm's `error` is `unknown`: it may be a translated `ProviderError`
 * (e.g. a 402) or the raw error passed through untouched (aborts, undocumented
 * statuses the profile declined to invent guidance for).
 */
export type ErrorDecision =
  | { retry: true; delayMs: number; error: ProviderError }
  | { retry: false; error: unknown };

/**
 * A provider account's spendable balance, surfaced on the status line. Returned
 * by {@link ProviderProfile.probeBalance} for providers that expose a balance
 * endpoint. `currency` is the union the built-in providers bill in (kept local
 * to `@nova/core` — this layer can't import `@nova/runtime`'s `Currency`,
 * but the two are structurally identical so it stays compatible with `formatMoney`).
 */
export interface AccountBalance {
  /** Currency the figures are denominated in. */
  currency: "USD" | "CNY";
  /** Total spendable balance (granted + topped-up) in `currency`. */
  total: number;
  /** Whether the account can currently be charged. */
  available: boolean;
}

/**
 * Char→token ratios for a tokenizer-free rough estimate, split by script:
 * `cjk` weights CJK ideographs / kana / hangul (which pack fewer chars per
 * token), `other` weights everything else (Latin, digits, JSON punctuation).
 * A provider carries these because the ratio is a property of its tokenizer;
 * the estimate feeds compaction thresholds and the `/context` breakdown, not
 * billing, so approximate values are fine. See `estimateTextTokens`.
 */
export interface TokenEstimate {
  /** Tokens per CJK/kana/hangul character. */
  cjk: number;
  /** Tokens per non-CJK character. */
  other: number;
}

/** Inputs for a balance probe — the live endpoint and credential from settings. */
export interface BalanceProbe {
  /** Configured base URL, if any; gates the provider's official-endpoint check. */
  baseURL?: string;
  /** API key used to authenticate the probe. */
  apiKey?: string;
}

export interface ProviderProfile {
  /**
   * Stable id; also the key in the {@link PROVIDERS} registry, which is the
   * single source of truth for the set of built-in ids ({@link ProviderId} is
   * derived from it). Typed as `string` so a new profile is one new file plus
   * one registry line — no hand-maintained union to widen here.
   */
  id: string;

  /**
   * Build the thinking-knob wire params for a given budget (in tokens).
   * `budget <= 0` means thinking is disabled. `model` is the concrete model id
   * the request targets, passed so a profile whose thinking wire shape depends
   * on the model (e.g. Moonshot, where `kimi-k2.7-code` forbids `type:"disabled"`
   * while `kimi-k2.5` forbids the `keep` field) can branch on it; profiles whose
   * knob is model-independent (DeepSeek, generic) simply ignore it.
   */
  thinking(budget: number, model?: string): ThinkingParams;

  /**
   * Char→token ratios for this provider's tokenizer, used by the rough
   * {@link TokenEstimate}-based estimator (compaction thresholds, `/context`
   * breakdown). A property of the tokenizer, so it lives on the profile rather
   * than being a global constant.
   */
  tokenEstimate: TokenEstimate;

  /**
   * Classify a thrown request error. `attempt` is the 1-based number of the try
   * that just failed (for computing backoff). Note: malformed tool-call JSON is
   * handled generically by the adapter *before* this is consulted, so profiles
   * only see genuine API/transport errors here.
   */
  onError(err: unknown, attempt: number): ErrorDecision;

  /**
   * Optionally fetch the account's spendable balance for a status display.
   * Present only for providers that expose a balance endpoint (e.g. DeepSeek's
   * `/user/balance`); absent on generic providers, where the status line simply
   * omits the segment. Best-effort: implementations resolve to `null` when the
   * configured base URL isn't this provider's official host, when no key is set,
   * or on any network/parse error — they never throw.
   */
  probeBalance?(probe: BalanceProbe): Promise<AccountBalance | null>;
}
