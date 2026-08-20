/**
 * A provider profile bundles everything the model adapter needs to know that
 * differs between LLM providers — which wire protocol it speaks, the
 * thinking-knob wire shape, and how to react to a failed request — behind one
 * interface. The adapter (`model.ts`) depends only on this shape and never on a
 * concrete provider, so adding a provider is adding a file that implements this
 * interface plus one line in the `PROVIDERS` registry (`index.ts`) — no hot-path
 * edit, and no id union to widen (the `id` field is `string`, and `ProviderId`
 * derives from the registry keys).
 */

import type { TokenEstimate } from "@nova/base";
import type { ProviderError } from "./error.js";

/**
 * The wire protocol used for a provider's model endpoint. "anthropic" goes
 * through the `@anthropic-ai/sdk` client (native Anthropic Messages format,
 * also spoken by DeepSeek / Moonshot's `/anthropic`-suffixed endpoints);
 * "openai" goes through the OpenAI-compatible `chat/completions` transport
 * (`openai.ts`, official `openai` SDK) — the protocol DeepSeek / Qwen / GLM /
 * MiniMax / Doubao are native to.
 *
 * Transport is INDEPENDENT of the provider: a vendor that ships both endpoints
 * (DeepSeek serves `/anthropic` AND `https://api.deepseek.com` from the same
 * key) keeps ONE profile — its error table, balance probe and docs all apply
 * to either wire — and the effective transport is `settings.transport` falling
 * back to the profile's {@link ProviderProfile.transport} default. The adapter
 * reads the effective transport once at construction and picks the branch.
 */
export type ModelTransport = "anthropic" | "openai";

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
 * to `@nova/core` — this layer can't import `@nova/base`'s `Currency`,
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
   * The wire protocol this provider is configured for. This is the DEFAULT —
   * `settings.transport` overrides it per install (see {@link ModelTransport}),
   * so a vendor with both endpoints (DeepSeek) keeps one profile and switches
   * protocols in config. "anthropic" (the default when omitted) routes through
   * the `@anthropic-ai/sdk` client; "openai" through the OpenAI-compatible
   * `chat/completions` transport. The rest of the profile — error policy,
   * balance probe, docs — applies on either wire; only the thinking knob is
   * transport-sensitive (see {@link ProviderProfile.thinking}).
   */
  transport?: ModelTransport;

  /**
   * Build the thinking-knob wire params for a given budget (in tokens).
   * `budget <= 0` means thinking is disabled. `model` is the concrete model id
   * the request targets, passed so a profile whose thinking wire shape depends
   * on the model (e.g. Moonshot, where `kimi-k2.7-code` forbids `type:"disabled"`
   * while `kimi-k2.5` forbids the `keep` field) can branch on it; profiles whose
   * knob is model-independent (DeepSeek, generic) simply ignore it.
   *
   * `transport` is the EFFECTIVE transport for this request (config override
   * when set, else the profile default) — the knob's wire shape is per-protocol:
   * DeepSeek's `output_config.effort` exists only on its Anthropic endpoint,
   * and its OpenAI endpoint has no effort parameter at all (the reasoner always
   * thinks, `chat` never does). A profile returns the shape matching the given
   * transport, so the SAME provider works on both wires.
   */
  thinking(budget: number, model: string | undefined, transport: ModelTransport): ThinkingParams;

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
