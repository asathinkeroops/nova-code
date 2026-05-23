import { readFile } from "node:fs/promises";
import * as readline from "node:readline";
import { DEFAULT_CONFIG_PATH, saveSettings, type Settings } from "@nova/runtime";
import { bold, cyan, dim, green, red } from "./colors.js";

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

function askLine(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let resolved = false;
    const done = (value: string | null): void => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve(value);
    };
    rl.on("SIGINT", () => done(null));
    rl.on("close", () => done(null));
    rl.question(prompt, (answer) => done(answer));
  });
}

function askMaskedLine(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      resolve(null);
      return;
    }

    let buffer = "";
    let settled = false;
    stdout.write(prompt);

    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
      try {
        stdin.pause();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const onData = (data: Buffer): void => {
      const str = data.toString("utf8");
      // Ctrl+C
      if (str === "\x03") {
        stdout.write("\n");
        settle(null);
        return;
      }
      // Ctrl+D on empty buffer = cancel; otherwise ignore
      if (str === "\x04") {
        if (buffer.length === 0) {
          stdout.write("\n");
          settle(null);
        }
        return;
      }
      // Enter
      if (str === "\r" || str === "\n") {
        stdout.write("\n");
        settle(buffer);
        return;
      }
      // Backspace
      if (str === "\x7f" || str === "\b") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          stdout.write("\b \b");
        }
        return;
      }
      // Ignore other control / escape sequences
      if (str.startsWith("\x1b")) return;
      const cleaned = str.replace(/[\x00-\x1f]/g, "");
      if (cleaned.length === 0) return;
      buffer += cleaned;
      stdout.write("*".repeat(cleaned.length));
    };

    try {
      stdin.setRawMode(true);
    } catch {
      // ignore
    }
    try {
      (stdin as { ref?: () => void }).ref?.();
    } catch {
      // ignore
    }
    stdin.on("data", onData);
    stdin.resume();
  });
}

export async function ensureSettings(
  settings: Settings,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<Settings> {
  const raw = await readRawConfig(configPath);
  const missing = PROMPTS.filter((p) => !hasValue(raw, p.key));
  if (missing.length === 0) return settings;

  if (!process.stdin.isTTY) {
    const names = missing.map((p) => p.key).join(", ");
    process.stderr.write(
      `Missing required settings: ${names}. Run interactively or set them in ${configPath}.\n`,
    );
    process.exit(2);
  }

  process.stdout.write(`\n${cyan(bold("Welcome to Nova!"))}\n`);
  process.stdout.write(
    `${dim(`Missing ${missing.length} setting${missing.length === 1 ? "" : "s"} — let's configure them. (Ctrl+C to abort)`)}\n`,
  );
  process.stdout.write(`${dim(`Config will be saved to: ${configPath}`)}\n`);
  if (missing.some((p) => p.key === "baseURL")) {
    process.stdout.write(
      `${dim("Note: baseURL must point to an Anthropic-compatible API endpoint.")}\n`,
    );
  }

  for (const p of missing) {
    let value: string | null = null;
    while (value === null) {
      process.stdout.write(`\n${cyan("?")} ${bold(p.label)} ${dim(`(${p.hint})`)}\n`);
      const answer = p.secret
        ? await askMaskedLine(`${cyan("›")} `)
        : await askLine(`${cyan("›")} `);
      if (answer === null) {
        process.stderr.write(`\n${red("✗")} setup aborted.\n`);
        process.exit(2);
      }
      const trimmed = answer.trim();
      const err = p.validate(trimmed);
      if (err) {
        process.stdout.write(`${red("✗")} ${err}\n`);
        continue;
      }
      value = trimmed;
    }

    settings[p.key] = value;
    try {
      await saveSettings({ [p.key]: value });
      process.stdout.write(`${green("✓")} ${dim(`saved ${p.label.toLowerCase()}`)}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${red("✗")} failed to save settings: ${msg}\n`);
      process.exit(2);
    }
  }

  process.stdout.write(`\n${green("✓")} ${dim("setup complete.")}\n`);
  return settings;
}
