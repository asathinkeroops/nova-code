import { readFile } from "node:fs/promises";
import { highlight } from "cli-highlight";
import {
  activeProvider,
  apiKeyFromEnv,
  DEFAULT_CONFIG_PATH,
  parseSettings,
  saveSettings,
  type ProviderEntry,
  type Settings,
} from "@nova/base";
import { accent, ACCENT_HEX, BLUE_RGB, dim, rgbFg } from "./colors.js";
import { t } from "./i18n/index.js";
import { PROVIDER_TEMPLATES, type ProviderTemplate } from "./provider-templates.js";
import { pickerArrow } from "./ui/picker.js";
import { fatalExit, type Screen } from "./screen.js";
import { settingsReadiness } from "./startup-readiness.js";
import { readCliVersion } from "./version.js";

/**
 * A setup-picker entry: one of the built-in {@link PROVIDER_TEMPLATES}, or the
 * "other" escape hatch that sends the user to hand-author a config file.
 */
type Choice = { kind: "template"; template: ProviderTemplate } | { kind: "other" };

/**
 * Whether the first-run picker offers the "Other provider" manual-config escape
 * hatch. Off while the bring-your-own-endpoint path is still unstable; the
 * branch it drives (`exitForManualConfig`) stays in place so flipping this back
 * to `true` re-opens it with no other change.
 */
const SHOW_OTHER_PROVIDER = false;

/**
 * A skeleton nova.config.json printed to the terminal when the user picks a
 * provider we have no template for, so they have the right shape to fill in.
 */
const EXAMPLE_CONFIG = `{
  "currentProvider": "<provider-name>",
  "providers": [
    {
      "name": "<provider-name>",
      "profile": "<deepseek|moonshot|other>",
      "baseURL": "<anthropic-compatible-url>",
      "apiKey": "<your-api-key>",
      "transport": "<anthropic|openai>",
      "models": {
        "lite": { "id": "<fast-cheap-model-id>", "contextWindowSize": 200000, "maxTokens": 8192 },
        "pro":  { "id": "<capable-model-id>", "contextWindowSize": 200000, "maxTokens": 8192 },
        "max":  { "id": "<most-capable-model-id>", "contextWindowSize": 200000, "maxTokens": 8192, "modalities": { "input": ["text", "image"] } }
      }
    }
  ],
  "model": "pro"
}`;

async function readRawConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Upsert one provider into the RAW on-disk array without copying the resolved
 * built-in model table out of `settings.providers`. Existing provider-local
 * overrides (`models`, `headers`, etc.) survive; the selected template updates
 * only the connection fields it owns. The caller has already parsed the config
 * successfully, so the final cast merely restores the schema-validated type
 * after preserving the raw JSON values.
 */
function upsertRawProvider(raw: Record<string, unknown>, entry: ProviderEntry): ProviderEntry[] {
  const providers = Array.isArray(raw["providers"]) ? raw["providers"] : [];
  let replaced = false;
  const next = providers.map((value) => {
    if (!isPlainObject(value) || value["name"] !== entry.name) return value;
    replaced = true;
    return {
      ...value,
      ...entry,
      // `entry.models` is deliberately empty (built-ins stay out of the file),
      // but an existing raw override belongs to the user and must survive.
      models: isPlainObject(value["models"]) ? value["models"] : entry.models,
    };
  });
  if (!replaced) next.push(entry);
  return next as ProviderEntry[];
}

/**
 * Bail out of the interactive flow for providers we don't template: print the
 * config-file path plus a starter config, then exit cleanly so the user can
 * author nova.config.json and re-launch.
 */
async function exitForManualConfig(screen: Screen, configPath: string): Promise<never> {
  await screen.unmount();
  const path = accent(configPath);
  const json = highlight(EXAMPLE_CONFIG, { language: "json", ignoreIllegals: true });
  process.stdout.write(
    `\n${t.setup.manualIntro(path)}\n\n` +
      `${t.setup.manualShape}\n\n${json}\n\n` +
      `${t.setup.manualRerun}\n`,
  );
  process.exit(0);
}

export async function ensureSettings(
  settings: Settings,
  screen: Screen,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<Settings> {
  const raw = await readRawConfig(configPath);
  const envKey = apiKeyFromEnv();
  // Headless startup checks this same predicate and fails fast; interactive
  // startup can repair either missing piece through the setup flow below.
  if (settingsReadiness(settings) === "ready") return settings;

  screen.beginSetup({
    header: {
      version: await readCliVersion(),
      configPath,
      missingCount: 1,
      noteBaseURL: false,
    },
    entries: [],
    currentPrompt: null,
  });

  try {
    const choices: Choice[] = [
      // `hidden` templates (e.g. providers still in internal testing) stay in the
      // registry but are withheld from the picker until they're opened.
      ...PROVIDER_TEMPLATES.filter((template) => !template.hidden).map((template) => ({
        kind: "template" as const,
        template,
      })),
      // The "Other provider" manual-config escape hatch is withheld too while
      // the bring-your-own-endpoint path is still shaking out — flip
      // SHOW_OTHER_PROVIDER back to true to re-open it; the code below stays wired.
      ...(SHOW_OTHER_PROVIDER ? [{ kind: "other" as const }] : []),
    ];
    // With a single provider on offer there's nothing to choose — skip the
    // overlay and go straight to its API-key prompt. The picker only earns its
    // keep once a second option (another template, or "Other") is in play.
    const choice =
      choices.length === 1
        ? (choices[0] as Choice)
        : await screen.pickOne<Choice>({
            items: choices,
            header: t.setup.providerQuestion,
            footer: dim(t.setup.providerFooter),
            border: false,
            topRuleColor: ACCENT_HEX,
            render: (it, selected) => {
              const name = it.kind === "other" ? t.setup.otherProvider : it.template.label;
              let badge = "";
              if (it.kind === "template") {
                if (it.template.recommended) badge = `  ${accent(t.setup.recommended)}`;
                else if (it.template.beta) badge = `  ${rgbFg(BLUE_RGB, t.setup.beta)}`;
              }
              return `${pickerArrow(selected)} ${name}${badge}`;
            },
          });
    if (choice === null) return fatalExit(screen, t.setup.aborted);

    // No built-in template for third-party providers: point the user at the
    // config-file path and let them author nova.config.json themselves.
    if (choice.kind === "other") return exitForManualConfig(screen, configPath);

    // A templated provider: its baseURL / model come from the template's
    // settings (and its tier table from the built-ins), so only the API key is
    // left to ask for — and even that is skipped when the env already has one.
    const { template } = choice;
    // If setup is repairing the active provider's endpoint/model table, reuse
    // its existing key. Never carry a key across profiles: a custom provider's
    // credential must not be copied into the DeepSeek template merely because
    // DeepSeek is currently the only visible setup choice.
    const current = activeProvider(settings);
    const activeProviderKey =
      (current?.profile ?? current?.name) === template.settings.provider
        ? current?.apiKey?.trim()
        : undefined;
    let value: string | null = envKey ?? activeProviderKey ?? null;
    while (value === null) {
      screen.setSetupPrompt({
        label: t.setup.apiKeyLabel,
        hint: template.apiKeyHint,
        provider: template.settings.provider,
      });
      const answer = await screen.promptInput({ mask: true });
      if (answer === null) await fatalExit(screen, t.setup.aborted);
      const trimmed = (answer as string).trim();
      if (trimmed.length === 0) {
        screen.pushSetupEntry({ kind: "err", text: t.setup.apiKeyEmpty });
        continue;
      }
      value = trimmed;
    }

    // Compose the selected template into a `providers` entry — the new home for
    // the provider's baseURL / transport / apiKey. The tier table is a built-in,
    // resolved from `profile` on every load (see mergeProviderModels), so the
    // entry deliberately carries NO `models`; it stays current as Nova ships new
    // defaults. An env-provided key stays in the env, never on disk.
    const profile = template.settings.provider;
    const entry: ProviderEntry = {
      name: template.id,
      profile,
      // The tier table is a built-in; an empty `models` is merged with it at
      // parse time (see mergeProviderModels), so the file stays current as Nova
      // ships new defaults.
      models: {},
      ...(template.settings.baseURL ? { baseURL: template.settings.baseURL } : {}),
      ...(template.settings.transport ? { transport: template.settings.transport } : {}),
      ...(envKey ? {} : { apiKey: value! }),
    };
    const patch: Partial<Settings> = {
      providers: upsertRawProvider(raw, entry),
      currentProvider: entry.name,
      ...(template.settings.model ? { model: template.settings.model } : {}),
      ...(template.settings.goal ? { goal: template.settings.goal } : {}),
    };
    try {
      await saveSettings(patch, configPath);
      // This session was booted from the pre-setup Settings object. Re-parse the
      // just-saved raw shape so provider-local overrides and built-in model
      // layering are reflected exactly as they will be on the next launch,
      // while leaving already-resolved session-wide values (notably language)
      // untouched. The env key remains memory-only and wins as usual.
      const next = parseSettings({ ...raw, ...patch });
      Object.assign(settings, {
        providers: next.providers,
        currentProvider: next.currentProvider,
        model: next.model,
        goal: next.goal,
      });
      screen.pushSetupEntry({ kind: "ok", text: t.setup.saved(template.label) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await fatalExit(screen, t.common.saveFailed(msg));
    }
  } finally {
    screen.endSetup();
  }

  return settings;
}
