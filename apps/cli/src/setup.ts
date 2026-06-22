import { readFile } from "node:fs/promises";
import { highlight } from "cli-highlight";
import { DEFAULT_CONFIG_PATH, saveSettings, type Settings } from "@nova/runtime";
import { accent } from "./colors.js";
import { PROVIDER_TEMPLATES, type ProviderTemplate } from "./provider-templates.js";
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
 * A skeleton nova.config.json printed to the terminal when the user picks a
 * provider we have no template for, so they have the right shape to fill in.
 */
const EXAMPLE_CONFIG = `{
  "apiKey": "<your-api-key>",
  "baseURL": "<anthropic-compatible-url>",
  "model": "default",
  "models": {
    "default": { "id": "<provider-model-id>", "contextWindowSize": 200000, "maxTokens": 8192 },
    "vision": { "id": "<provider-vision-model-id>", "contextWindowSize": 200000, "maxTokens": 8192, "modalities": { "input": ["text", "image"] } }
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
    `\nTo use another provider, create your config file at: ${path}\n\n` +
      `with settings shaped like:\n\n${json}\n\n` +
      `Then run nova again.\n`,
  );
  process.exit(0);
}

export async function ensureSettings(
  settings: Settings,
  screen: Screen,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<Settings> {
  const raw = await readRawConfig(configPath);
  // The only value we must collect interactively is the API key — baseURL,
  // model and the models table all carry DeepSeek-flavoured schema defaults,
  // so a key alone makes the CLI usable out of the box.
  if (hasValue(raw, "apiKey")) return settings;

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
      ...PROVIDER_TEMPLATES.map((template) => ({ kind: "template" as const, template })),
      { kind: "other" as const },
    ];
    const choice = await screen.pickHorizontal<Choice>({
      items: choices,
      label: (it) => (it.kind === "other" ? "Other provider" : it.template.label),
      badge: (it) =>
        it.kind === "template" && it.template.recommended ? "★ recommended" : null,
      header: "Which provider are you connecting to?",
      footer: "←/→ to choose · Enter to confirm · Ctrl+C to abort",
    });
    if (choice === null) return fatalExit(screen, "setup aborted.");

    // No built-in template for third-party providers: point the user at the
    // config-file path and let them author nova.config.json themselves.
    if (choice.kind === "other") return exitForManualConfig(screen, configPath);

    // A templated provider: its baseURL / model / models come from the template
    // (or the schema defaults), so only the API key is left to ask for.
    const { template } = choice;
    let value: string | null = null;
    while (value === null) {
      screen.setSetupPrompt({ label: "API key", hint: template.apiKeyHint });
      const answer = await screen.promptInput({ mask: true });
      if (answer === null) await fatalExit(screen, "setup aborted.");
      const trimmed = (answer as string).trim();
      if (trimmed.length === 0) {
        screen.pushSetupEntry({ kind: "err", text: "✗ API key cannot be empty" });
        continue;
      }
      value = trimmed;
    }

    const patch: Partial<Settings> = { ...template.settings, apiKey: value };
    try {
      await saveSettings(patch, configPath);
      Object.assign(settings, patch);
      screen.pushSetupEntry({ kind: "ok", text: `✓ saved ${template.label} settings` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await fatalExit(screen, `failed to save settings: ${msg}`);
    }
  } finally {
    screen.endSetup();
  }

  return settings;
}
