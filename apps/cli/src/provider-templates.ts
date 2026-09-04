import type {
  ModelTransport,
  ProviderId,
} from "@nova/model";
import { DEFAULT_GOAL, DEFAULT_MODEL_TIER } from "@nova/base";

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
   * Settings applied when this template is chosen. The provider-scoped pieces
   * (`provider` = profile id, `transport`, `baseURL`) are composed into a
   * `providers` array entry (name = this `id`, profile = this `provider`); the
   * API key is collected separately and added to that entry. `model` and `goal`
   * stay at the config top level. Any omitted field falls back to the
   * config-schema default.
   *
   * Note what is NOT here: the `models` tier table. It lives in
   * `BUILTIN_PROVIDER_MODELS` (`@nova/base`), keyed by this `provider`, and
   * is layered in at parse time rather than persisted — so a shipped model /
   * price / limit update reaches installs that were set up long ago.
   */
  settings: {
    // A built-in template targets a built-in profile, so this is the narrow
    // `ProviderId` even though a provider entry's `profile` is a free-form string.
    // Required: it is also the key into the built-in `models` table.
    provider: ProviderId;
    // Wire protocol for the model endpoint. Omitted → the profile's default
    // (anthropic). A vendor shipping both endpoints (DeepSeek) pins its
    // preferred wire here; the baseURL below must match it.
    transport?: ModelTransport;
    baseURL?: string;
    model?: string;
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
    settings: {
      provider: "deepseek",
      // DeepSeek's OpenAI-compatible endpoint (their recommended protocol, and
      // the one the official `openai` SDK speaks natively) — written explicitly
      // here so the saved config is self-describing. This is the sole place a
      // DeepSeek base URL is hardcoded — the config schema no longer defaults
      // `baseURL`. The transport pin (`openai`) keeps the wire and the URL in
      // sync; the same provider profile also serves the `/anthropic` endpoint
      // if a user switches `transport` back.
      transport: "openai",
      baseURL: "https://api.deepseek.com",
      model: DEFAULT_MODEL_TIER,
      // Goal mode on by default; judged by the cheap `lite` tier so the
      // after-each-turn check stays inexpensive. Persisted to nova.config.json.
      goal: { ...DEFAULT_GOAL, evalModel: "lite" },
    },
    apiKeyHint: "DeepSeek API key (input is masked)",
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    settings: {
      provider: "moonshot",
      // Moonshot's Anthropic-compatible endpoint (国内站, bills in CNY).
      baseURL: "https://api.moonshot.cn/anthropic",
      model: DEFAULT_MODEL_TIER,
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
