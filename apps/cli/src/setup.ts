import { readFile } from "node:fs/promises";
import { highlight } from "cli-highlight";
import { apiKeyFromEnv, DEFAULT_CONFIG_PATH, saveSettings, type Settings } from "@nova/runtime";
import { accent, ACCENT_HEX, BLUE_RGB, dim, rgbFg } from "./colors.js";
import { t } from "./i18n/index.js";
import { PROVIDER_TEMPLATES, type ProviderTemplate } from "./provider-templates.js";
import { pickerArrow } from "./ui/picker.js";
import { fatalExit, type Screen } from "./screen.js";
import { readCliVersion } from "./version.js";

/**
 * A setup-picker entry: one of the built-in {@link PROVIDER_TEMPLATES}, or the
 * "other" escape hatch that sends the user to hand-author a config file.
 */
type Choice =
  | { kind: "template"; template: ProviderTemplate }
  | { kind: "other" };

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
  "apiKey": "<your-api-key>",
  "baseURL": "<anthropic-compatible-url>",
  "model": "pro",
  "models": {
    "lite": { "id": "<fast-cheap-model-id>", "contextWindowSize": 200000, "maxTokens": 8192 },
    "pro":  { "id": "<capable-model-id>", "contextWindowSize": 200000, "maxTokens": 8192 },
    "max":  { "id": "<most-capable-model-id>", "contextWindowSize": 200000, "maxTokens": 8192, "modalities": { "input": ["text", "image"] } }
  }
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

function hasValue(raw: Record<string, unknown>, key: string): boolean {
  const v = raw[key];
  return typeof v === "string" && v.trim().length > 0;
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
  // The only value we must collect interactively is the API key — a chosen
  // provider template supplies baseURL / model / the models table (the schema
  // no longer defaults baseURL or models), so a key alone completes setup.
  if (hasValue(raw, "apiKey")) return settings;
  // `$NOVA_API_KEY` satisfies the key requirement just as well, but it says
  // nothing about the endpoint: without a `models` table there is still no
  // usable config, so fall through and run the picker — minus the key prompt,
  // and without ever writing the env key to disk (see resolveApiKey).
  const envKey = apiKeyFromEnv();
  if (envKey && Object.keys(settings.models).length > 0) return settings;

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

    // A templated provider: its baseURL / model / models all come from the
    // template's settings, so only the API key is left to ask for — and even
    // that is skipped when the environment already supplies one.
    const { template } = choice;
    let value: string | null = envKey ?? null;
    while (value === null) {
      screen.setSetupPrompt({
        label: t.setup.apiKeyLabel,
        hint: template.apiKeyHint,
        ...(template.settings.provider ? { provider: template.settings.provider } : {}),
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

    // An env-provided key stays in the env — persist the template only.
    const patch: Partial<Settings> = envKey
      ? { ...template.settings }
      : { ...template.settings, apiKey: value };
    try {
      await saveSettings(patch, configPath);
      Object.assign(settings, patch);
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
