import { DEFAULT_TOKEN_ESTIMATE } from "@nova/runtime";
import type { ProviderProfile } from "./types.js";

/**
 * Generic Anthropic-compatible provider — first-party Claude and any other
 * endpoint that speaks the native format. Uses `thinking.budget_tokens` and
 * imposes the `max_tokens > budget_tokens` floor. It applies no provider-specific
 * error translation and does not retry on HTTP status (transient-failure retry
 * policies vary by provider, so we don't assume one); the shared adapter still
 * retries malformed tool-call JSON generically.
 */
export const otherProfile: ProviderProfile = {
  id: "other",

  // No provider-specific tokenizer known for a generic endpoint; the neutral
  // default (~0.3/char Latin, ~0.6 CJK) is a reasonable approximation.
  tokenEstimate: DEFAULT_TOKEN_ESTIMATE,

  thinking(budget) {
    if (budget <= 0) return { params: { thinking: { type: "disabled" } } };
    return {
      params: { thinking: { type: "enabled", budget_tokens: budget } },
      minMaxTokens: budget + 8192,
    };
  },

  onError(err) {
    return { retry: false, error: err };
  },
};
