import {
  activeModels,
  activeProvider,
  activeProviderProfile,
  resolveApiKey,
  type Settings,
} from "@nova/base";
import { resolveProfile } from "@nova/model";

export type SettingsReadiness = "ready" | "missing-api-key" | "missing-models" | "missing-base-url";

/**
 * Whether the active provider has enough configuration to construct a model
 * client. Interactive startup uses a missing state to launch setup; headless
 * startup uses the same state to fail fast because it cannot prompt.
 */
export function settingsReadiness(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): SettingsReadiness {
  const provider = activeProvider(settings);
  const effectiveKey = resolveApiKey(settings, env)?.trim();
  if (!effectiveKey) return "missing-api-key";
  if (Object.keys(activeModels(settings)).length === 0) return "missing-models";

  const profile = resolveProfile(activeProviderProfile(settings) ?? "other");
  const transport = provider?.transport ?? profile.transport ?? "anthropic";
  // OpenAI-compatible requests cannot be framed without an endpoint. DeepSeek
  // and Moonshot also require one on their Anthropic-compatible wires; allowing
  // the SDK default there would send a vendor key to Anthropic's public API.
  const needsExplicitBaseURL =
    transport === "openai" || profile.id === "deepseek" || profile.id === "moonshot";
  if (needsExplicitBaseURL && !provider?.baseURL?.trim()) return "missing-base-url";

  return "ready";
}
