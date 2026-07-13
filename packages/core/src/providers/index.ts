import { deepseekProfile } from "./deepseek.js";
import { otherProfile } from "./other.js";
import type { ProviderProfile } from "./types.js";

export type {
  ProviderProfile,
  ThinkingParams,
  ErrorDecision,
  AccountBalance,
  BalanceProbe,
} from "./types.js";

/** Registry of built-in provider profiles, keyed by their stable id. */
export const PROVIDERS = {
  deepseek: deepseekProfile,
  other: otherProfile,
} as const satisfies Record<string, ProviderProfile>;

export type ProviderId = keyof typeof PROVIDERS;

/**
 * Resolve the profile for a provider id (`settings.provider`). A plain registry
 * lookup — `provider` is always present (the config schema defaults it), so there
 * is no model-name guessing: the id is the single source of truth.
 */
export function resolveProfile(id: ProviderId): ProviderProfile {
  return PROVIDERS[id];
}
