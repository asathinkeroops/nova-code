import {
  DEFAULT_BASE_URL,
  DEFAULT_MODELS,
  DEFAULT_MODEL_TIER,
  type ModelProfile,
} from "@nova/runtime";

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
   * omitted field falls back to the config-schema default. DeepSeek leaves this
   * empty because the schema defaults (baseURL / model / models) already target
   * it; a third-party provider sets at least `baseURL`, `model`, and `models`.
   */
  settings: {
    baseURL?: string;
    model?: string;
    models?: Record<string, ModelProfile>;
  };
  /** One-line hint shown beneath the API-key prompt. */
  apiKeyHint: string;
}

/**
 * The built-in templates, in picker order. Only DeepSeek today; the registry
 * exists so more presets are a one-line append rather than a control-flow edit.
 */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    // Mirrors the config-schema defaults (same source of truth), written
    // explicitly so the saved nova.config.json is self-describing.
    settings: {
      baseURL: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL_TIER,
      models: DEFAULT_MODELS,
    },
    apiKeyHint: "DeepSeek API key (input is masked)",
  },
];
