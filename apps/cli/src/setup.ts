import { readFile } from "node:fs/promises";
import { DEFAULT_CONFIG_PATH, saveSettings, type Settings } from "@nova/runtime";
import { bold, cyan, dim, green, red } from "./colors.js";
import type { Screen } from "./screen.js";

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

  screen.print(`\n${cyan(bold("Welcome to Nova!"))}\n`);
  screen.print(
    `${dim(`Missing ${missing.length} setting${missing.length === 1 ? "" : "s"} — let's configure them. (Ctrl+C to abort)`)}\n`,
  );
  screen.print(`${dim(`Config will be saved to: ${configPath}`)}\n`);
  if (missing.some((p) => p.key === "baseURL")) {
    screen.print(
      `${dim("Note: baseURL must point to an Anthropic-compatible API endpoint.")}\n`,
    );
  }

  for (const p of missing) {
    let value: string | null = null;
    while (value === null) {
      screen.print(`\n${cyan("?")} ${bold(p.label)} ${dim(`(${p.hint})`)}\n`);
      const answer = await screen.promptInput(p.secret ? { mask: true } : {});
      if (answer === null) {
        screen.printErr(`\n${red("✗")} setup aborted.\n`);
        await screen.unmount();
        process.exit(2);
      }
      const trimmed = answer.trim();
      const err = p.validate(trimmed);
      if (err) {
        screen.print(`${red("✗")} ${err}\n`);
        continue;
      }
      value = trimmed;
    }

    settings[p.key] = value;
    try {
      await saveSettings({ [p.key]: value });
      screen.print(`${green("✓")} ${dim(`saved ${p.label.toLowerCase()}`)}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      screen.printErr(`${red("✗")} failed to save settings: ${msg}\n`);
      await screen.unmount();
      process.exit(2);
    }
  }

  screen.print(`\n${green("✓")} ${dim("setup complete.")}\n`);
  return settings;
}
