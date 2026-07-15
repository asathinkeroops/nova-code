import type { ProviderId } from "@nova/core";
import { DEFAULT_GOAL, DEFAULT_MODEL_TIER, type ModelProfile } from "@nova/runtime";

/**
 * DeepSeek's built-in performance tiers, written verbatim into the config when
 * the DeepSeek template is chosen. Three fixed rungs — lite / pro / max: `lite`
 * maps to the cheap `deepseek-v4-flash`; `pro` and `max` share the capable
 * `deepseek-v4-pro` id and differ only in reasoning depth via the per-tier
 * `thinking` level (low → high → max), a genuine speed/cost ↔ capability ladder
 * on the two available models. The config schema no longer defaults `models`,
 * so this provider-specific set lives with the provider template that uses it.
 */
const DEEPSEEK_MODELS: Record<string, ModelProfile> = {
  lite: {
    id: "deepseek-v4-flash",
    maxTokens: 384_000,
    contextWindowSize: 1_000_000,
    thinking: "low",
    modalities: { input: ["text"] },
    // CNY per 1M tokens; `input` is cache-miss, `cacheRead` cache-hit.
    pricing: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1, currency: "CNY" },
  },
  pro: {
    id: "deepseek-v4-pro",
    maxTokens: 384_000,
    contextWindowSize: 1_000_000,
    thinking: "high",
    modalities: { input: ["text"] },
    pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3, currency: "CNY" },
  },
  max: {
    id: "deepseek-v4-pro",
    maxTokens: 384_000,
    contextWindowSize: 1_000_000,
    thinking: "max",
    modalities: { input: ["text"] },
    // Same concrete id as `pro`, so same list price.
    pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3, currency: "CNY" },
  },
};

/**
 * Moonshot (Kimi) tiers. All three rungs run 256K-context / 256K-output code
 * models. `lite` maps to `kimi-k2.5` with thinking off (fast & cheap); `pro` and
 * `max` map to the always-thinking code models `kimi-k2.7-code-highspeed` and
 * `kimi-k2.7-code` — same 256K envelope, `max` trading speed for the full model.
 * The per-tier `thinking` level here is what the Moonshot profile reads to shape
 * the `thinking: { type, keep }` knob (see providers/moonshot.ts).
 */
const MOONSHOT_MODELS: Record<string, ModelProfile> = {
  lite: {
    id: "kimi-k2.5",
    maxTokens: 256_000,
    contextWindowSize: 256_000,
    thinking: "off",
    modalities: { input: ["text"] },
    // CNY per 1M tokens; `input` is cache-miss, `cacheRead` cache-hit.
    pricing: { input: 4, output: 21, cacheRead: 0.7, cacheWrite: 4, currency: "CNY" },
  },
  pro: {
    id: "kimi-k2.7-code-highspeed",
    maxTokens: 256_000,
    contextWindowSize: 256_000,
    thinking: "max",
    modalities: { input: ["text", "image"] },
    pricing: { input: 13, output: 54, cacheRead: 2.6, cacheWrite: 13, currency: "CNY" },
  },
  max: {
    id: "kimi-k2.7-code",
    maxTokens: 256_000,
    contextWindowSize: 256_000,
    thinking: "max",
    modalities: { input: ["text", "image"] },
    pricing: { input: 6.5, output: 27, cacheRead: 1.3, cacheWrite: 6.5, currency: "CNY" },
  },
};

/**
 * A built-in provider preset surfaced in the first-run setup picker. Choosing
 * one persists its `settings` (everything but the API key) and then prompts
 * only for the key — so onboarding a templated provider is a single input.
 *
 * To add a provider, append an entry here: give it a stable `id`, a display
 * `label`, the `settings` to write (omit a field to keep the config-schema
 * default), and an `apiKeyHint`. No other file needs to change.
 */
export interface ProviderTemplate {
  /** Stable identifier; also the picker key. */
  id: string;
  /** Display name shown in the setup picker. */
  label: string;
  /**
   * Settings persisted (besides the API key) when this template is chosen. Any
   * omitted field falls back to the config-schema default. `baseURL` and
   * `models` have no schema default (they are provider-specific), so any
   * template must set at least `baseURL`, `model`, and `models` for a usable
   * out-of-the-box config.
   */
  settings: {
    // A built-in template targets a built-in profile, so this is the narrow
    // `ProviderId` even though `settings.provider` itself is a free-form string.
    provider?: ProviderId;
    baseURL?: string;
    model?: string;
    models?: Record<string, ModelProfile>;
    goal?: {
      enabled: boolean;
      evalModel?: string;
      maxContinuations: number;
      maxEvalTurns: number;
    };
  };
  /** One-line hint shown beneath the API-key prompt. */
  apiKeyHint: string;
  /** When true, the picker tags this provider as highly recommended. */
  recommended?: boolean;
  /**
   * When true, the picker tags this provider with a blue "Beta" badge — the
   * integration (or the models it targets) isn't GA yet and may misbehave.
   */
  beta?: boolean;
  /**
   * When true, the template is kept in the registry (code, art, profile all
   * intact) but withheld from the first-run setup picker — used to gate a
   * provider that's still in internal testing. Flip to `false`/remove to open
   * it once its testing passes; no other file changes. A manually-authored
   * config targeting the provider still works — only the picker hides it.
   */
  hidden?: boolean;
}

/**
 * The built-in templates, in picker order. Only DeepSeek today; the registry
 * exists so more presets are a one-line append rather than a control-flow edit.
 */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    // Every field written explicitly so the saved nova.config.json is fully
    // self-describing — the schema no longer defaults baseURL or models.
    settings: {
      provider: "deepseek",
      // DeepSeek's Anthropic-compatible endpoint, written explicitly here so the
      // saved config is self-describing. This is the sole place a DeepSeek base
      // URL is hardcoded — the config schema no longer defaults `baseURL`.
      baseURL: "https://api.deepseek.com/anthropic",
      model: DEFAULT_MODEL_TIER,
      models: DEEPSEEK_MODELS,
      // Goal mode on by default; judged by the cheap `lite` tier so the
      // after-each-turn check stays inexpensive. Persisted to nova.config.json.
      goal: { ...DEFAULT_GOAL, evalModel: "lite" },
    },
    apiKeyHint: "DeepSeek API key (input is masked)",
    recommended: true,
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    settings: {
      provider: "moonshot",
      // Moonshot's Anthropic-compatible endpoint (国内站, bills in CNY).
      baseURL: "https://api.moonshot.cn/anthropic",
      model: DEFAULT_MODEL_TIER,
      models: MOONSHOT_MODELS,
      // Goal mode judged by the cheap `lite` tier, mirroring the DeepSeek preset.
      goal: { ...DEFAULT_GOAL, evalModel: "lite" },
    },
    apiKeyHint: "Moonshot API key (input is masked)",
    beta: true,
    // Still in internal testing — hidden from the picker until it passes. Remove
    // this flag (or set false) to open it; everything else is already wired up.
    hidden: true,
  },
];
