/**
 * A provider profile bundles everything the model adapter needs to know that
 * differs between LLM providers — the thinking-knob wire shape and how to react
 * to a failed request — behind one interface. The adapter (`model.ts`) depends
 * only on this shape and never on a concrete provider, so adding a provider is
 * adding a file that implements this interface, not editing the hot path.
 *
 * All providers here speak the Anthropic-compatible wire format (they go through
 * the same `@anthropic-ai/sdk` client); a profile only captures the *quirks* on
 * top of that, not a whole alternate transport.
 */

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
 * throw `error` (the provider's final, possibly-translated error). `error` is
 * present on both arms so the adapter can throw it once the retry budget is
 * exhausted, without the provider having to recompute it.
 */
export type ErrorDecision =
  | { retry: true; delayMs: number; status?: number; error: unknown }
  | { retry: false; error: unknown };

export interface ProviderProfile {
  /** Stable id; also the key in the {@link PROVIDERS} registry. */
  id: "deepseek" | "other";

  /**
   * Build the thinking-knob wire params for a given budget (in tokens).
   * `budget <= 0` means thinking is disabled.
   */
  thinking(budget: number): ThinkingParams;

  /**
   * Classify a thrown request error. `attempt` is the 1-based number of the try
   * that just failed (for computing backoff). Note: malformed tool-call JSON is
   * handled generically by the adapter *before* this is consulted, so profiles
   * only see genuine API/transport errors here.
   */
  onError(err: unknown, attempt: number): ErrorDecision;
}
