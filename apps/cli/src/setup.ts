import { readFile } from "node:fs/promises";
import { DEFAULT_CONFIG_PATH, saveSettings, type Settings } from "@nova/runtime";
import { fatalExit, type Screen } from "./screen.js";

type RequiredKey = "apiKey" | "model" | "baseURL";

interface SettingPrompt {
  key: RequiredKey;
  label: string;
  hint: string;
  secret?: boolean;
  validate: (input: string) => string | null;
}

const PROMPTS: SettingPrompt[] = [
  {
    key: "baseURL",
    label: "Base URL",
    hint: "must be Anthropic-compatible (e.g. https://api.anthropic.com)",
    validate: (s) => {
      if (s.length === 0) return "Base URL cannot be empty";
      try {
        new URL(s);
        return null;
      } catch {
        return "Invalid URL";
      }
    },
  },
  {
    key: "apiKey",
    label: "API key",
    hint: "provider API key (input is masked)",
    secret: true,
    validate: (s) => (s.length > 0 ? null : "API key cannot be empty"),
  },
  {
    key: "model",
    label: "Model",
    hint: "e.g. claude-sonnet-4-5",
    validate: (s) => (s.length > 0 ? null : "Model cannot be empty"),
  },
];

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

export async function ensureSettings(
  settings: Settings,
  screen: Screen,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<Settings> {
  const raw = await readRawConfig(configPath);
  const missing = PROMPTS.filter((p) => !hasValue(raw, p.key));
  if (missing.length === 0) return settings;

  screen.beginSetup({
    header: {
      configPath,
      missingCount: missing.length,
      noteBaseURL: missing.some((p) => p.key === "baseURL"),
    },
    entries: [],
    currentPrompt: null,
  });

  try {
    for (const p of missing) {
      let value: string | null = null;
      while (value === null) {
        screen.setSetupPrompt({ label: p.label, hint: p.hint });
        const answer = await screen.promptInput(p.secret ? { mask: true } : {});
        if (answer === null) {
          await fatalExit(screen, "setup aborted.");
        }
        const trimmed = (answer as string).trim();
        const err = p.validate(trimmed);
        if (err) {
          screen.pushSetupEntry({ kind: "err", text: `✗ ${err}` });
          continue;
        }
        value = trimmed;
      }

      settings[p.key] = value;
      try {
        await saveSettings({ [p.key]: value });
        screen.pushSetupEntry({
          kind: "ok",
          text: `✓ saved ${p.label.toLowerCase()}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await fatalExit(screen, `failed to save settings: ${msg}`);
      }
    }
  } finally {
    screen.endSetup();
  }

  return settings;
}
