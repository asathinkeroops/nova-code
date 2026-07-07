import { toDeepSeekApiError } from "../deepseek-errors.js";
import { backoffMs } from "../retry.js";
import { THINKING_BUDGETS } from "../thinking.js";
import type { ProviderProfile } from "./types.js";

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
 * failures are translated into actionable diagnostics with transient statuses
 * retried. See `deepseek-errors.ts` for the error-table internals.
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
    const api = toDeepSeekApiError(err);
    // Undocumented status / abort / connection failure: pass the raw error
    // through untranslated rather than inventing guidance.
    if (!api) return { retry: false, error: err };
    if (api.retryable) {
      return {
        retry: true,
        delayMs: backoffMs(attempt, api.retryAfterSeconds),
        status: api.status,
        error: api,
      };
    }
    return { retry: false, error: api };
  },
};
