import { deepseekProfile } from "./deepseek.js";
import { moonshotProfile } from "./moonshot.js";
import { otherProfile } from "./other.js";
import type { ProviderProfile } from "./types.js";

export type {
  ProviderProfile,
  ThinkingParams,
  ErrorDecision,
  AccountBalance,
  BalanceProbe,
  ModelTransport,
} from "./types.js";
export { ProviderError } from "./error.js";
export type { ProviderErrorInfo } from "./error.js";

/** Registry of built-in provider profiles, keyed by their stable id. */
export const PROVIDERS = {
  deepseek: deepseekProfile,
  moonshot: moonshotProfile,
  other: otherProfile,
} as const satisfies Record<string, ProviderProfile>;

export type ProviderId = keyof typeof PROVIDERS;

/** The built-in provider ids, derived from the registry (the single source of truth). */
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** Whether `id` names a built-in provider profile. Narrows to {@link ProviderId}. */
export function isProviderId(id: string): id is ProviderId {
  return id in PROVIDERS;
}

/**
 * Resolve the profile for a provider entry's profile id. The config schema
 * types `provider` as a free-form string (it lives in `@nova/base`, a leaf
 * that can't import this registry, so it can't enumerate the ids), so an unknown
 * id — a typo, or a generic third-party provider named directly — falls back to
 * the `other` profile rather than throwing. Callers that want to flag an unknown
 * id (e.g. `nova doctor`) check {@link isProviderId} first.
 */
export function resolveProfile(id: string): ProviderProfile {
  return isProviderId(id) ? PROVIDERS[id] : PROVIDERS.other;
}
