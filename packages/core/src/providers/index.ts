import { deepseekProfile } from "./deepseek.js";
import { otherProfile } from "./other.js";
import type { ProviderProfile } from "./types.js";

export type { ProviderProfile, ThinkingParams, ErrorDecision } from "./types.js";

/** Registry of built-in provider profiles, keyed by their stable id. */
export const PROVIDERS = {
  deepseek: deepseekProfile,
  other: otherProfile,
} as const satisfies Record<string, ProviderProfile>;

export type ProviderId = keyof typeof PROVIDERS;

/**
 * Resolve the profile to use. An explicit id (from `settings.provider`) wins;
 * when absent — e.g. an older config written before the field existed — fall
 * back to guessing from the model name so behavior is unchanged. The regex lives
 * only on this cold config-resolution path, never in the request hot loop.
 */
export function resolveProfile(id: string | undefined, model: string): ProviderProfile {
  if (id === "deepseek") return deepseekProfile;
  if (id === "other") return otherProfile;
  return /deepseek/i.test(model) ? deepseekProfile : otherProfile;
}
