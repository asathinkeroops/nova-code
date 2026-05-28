import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".nova", "nova.config.json");

export const permissionRuleSchema = z.object({
  tool: z.string(),
  effect: z.enum(["allow", "deny", "ask"]),
  match: z.record(z.unknown()).optional(),
});

export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const DEFAULT_MEMORY_FILENAMES = ["NOVA.md", "CLAUDE.md", "AGENTS.md"] as const;

export const settingsSchema = z.object({
  apiKey: z.string().min(1).optional(),
  model: z.string().default("claude-sonnet-4-5"),
  baseURL: z.string().url().optional(),
  sessionDir: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().default(8192),
  contextWindowTokens: z.number().int().positive().default(256_000),
  maxTurns: z.number().int().positive().default(40),
  // Schema only — concrete tool-name defaults live with the layer that
  // registers those tools (apps/cli/src/permissions.ts). @nova/runtime must
  // not know about specific tool identifiers.
  permissions: z
    .object({
      defaultEffect: z.enum(["allow", "deny", "ask"]).default("ask"),
      rules: z.array(permissionRuleSchema).default([]),
    })
    .default({ defaultEffect: "ask", rules: [] }),
  transcript: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  logging: z
    .object({
      level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
      pretty: z.boolean().default(true),
    })
    .default({ level: "info", pretty: true }),
  thinking: z
    .object({
      level: z.enum(["off", "low", "medium", "high", "max"]).default("off"),
      // Explicit override wins over the level mapping when set; lets users
      // dial in an exact `budget_tokens` without inventing a new level.
      budgetTokens: z.number().int().positive().optional(),
      // Wire format for the thinking parameter. Omit to auto-detect from the
      // model id (DeepSeek uses output_config.effort, not budget_tokens).
      format: z.enum(["anthropic", "deepseek"]).optional(),
    })
    .default({ level: "off" }),
  memory: z
    .object({
      filenames: z
        .array(z.string().min(1))
        .nonempty()
        .default([...DEFAULT_MEMORY_FILENAMES]),
      userPaths: z.array(z.string().min(1)).optional(),
      globalPath: z.string().min(1).optional(),
    })
    .default({ filenames: [...DEFAULT_MEMORY_FILENAMES] }),
  // compact overrides — tuning fields are optional and default to the constants
  // in @nova/context/compact.ts (single source of truth). `enabled` is a
  // runtime concern (whether to invoke compact at all) so it defaults here.
  //
  // micro defaults OFF: it rewrites older tool_results every turn, which
  // invalidates the provider's automatic prefix cache (e.g. DeepSeek context
  // caching) from the rewrite point to the end on each request — and the tokens
  // it trims would otherwise bill at the cheap cache-read rate, so the net is
  // marginal-to-negative on cache-friendly providers. auto_compact handles
  // context-window pressure on its own. Set micro.enabled=true on a provider
  // with no prompt caching (e.g. Anthropic without cache_control breakpoints).
  compact: z
    .object({
      micro: z
        .object({
          enabled: z.boolean().default(false),
          keepRecent: z.number().int().nonnegative().optional(),
          minContentChars: z.number().int().nonnegative().optional(),
          preserveTools: z.array(z.string().min(1)).optional(),
        })
        .default({ enabled: false }),
      auto: z
        .object({
          enabled: z.boolean().default(true),
          thresholdTokens: z.number().int().positive().optional(),
          contextWindowPercent: z.number().positive().max(1).optional(),
          maxSummaryTokens: z.number().int().positive().optional(),
        })
        .default({ enabled: true }),
    })
    .default({ micro: { enabled: false }, auto: { enabled: true } }),
  // Tool invariants (read-before-edit, mtime drift). Enforced by the
  // dispatcher before each read/write/edit.
  invariants: z
    .object({
      enabled: z.boolean().default(true),
      readBeforeEdit: z.boolean().default(true),
      mtimeCheck: z.boolean().default(true),
    })
    .default({ enabled: true, readBeforeEdit: true, mtimeCheck: true }),
  // Next-user-input prediction shown as the input box placeholder. The CLI
  // runs this once after each successful agent turn using the main model.
  predict: z
    .object({
      enabled: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(8000),
      maxChars: z.number().int().positive().default(20),
    })
    .default({ enabled: true, timeoutMs: 8000, maxChars: 20 }),
  // Custom slash commands loaded from .md templates. Project layer
  // (.nova/commands → .claude/commands → .commands) wins over user layer
  // (~/.nova/commands → ~/.claude/commands); builtins always win on
  // name collisions.
  slash: z
    .object({
      enabled: z.boolean().default(true),
      projectDirs: z.array(z.string().min(1)).optional(),
      userPaths: z.array(z.string().min(1)).optional(),
      extraDirs: z.array(z.string().min(1)).optional(),
    })
    .default({ enabled: true }),
  // Skills: SKILL.md files scanned from project / user roots, surfaced to
  // the model as an index in the system prompt and pulled in full via the
  // loadSkill tool. Mirrors `slash` for layering + cache windowing.
  skills: z
    .object({
      enabled: z.boolean().default(true),
      projectDirs: z.array(z.string().min(1)).optional(),
      userPaths: z.array(z.string().min(1)).optional(),
      extraDirs: z.array(z.string().min(1)).optional(),
      maxIndexBytes: z.number().int().positive().default(8_192),
      maxResponseBytes: z.number().int().positive().default(16_384),
    })
    .default({ enabled: true, maxIndexBytes: 8_192, maxResponseBytes: 16_384 }),
  // Sub-agents spawned via the createSubAgent tool. They run in-process with a
  // fresh context and the parent's tool set (minus createSubAgent itself, to
  // prevent unbounded recursion). `model` defaults to the parent's model.
  subagent: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().min(1).optional(),
      maxTurns: z.number().int().positive().default(30),
      // Per-response output cap for the sub-agent loop, tunable independently
      // of the top-level maxTokens. A sub-agent's final message is a single
      // consolidated report, so a small budget risks the loop's max_tokens
      // hard-stop. 8192 is the safe ceiling for DeepSeek's Anthropic-compatible
      // endpoint.
      maxTokens: z.number().int().positive().default(8192),
    })
    .default({ enabled: true, maxTurns: 30, maxTokens: 8192 }),
});

export type Settings = z.infer<typeof settingsSchema>;

const DEFAULT_DENY_BASH = [
  /(^|\s)rm\s+-r\w*\s+\//,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/,
  /(^|\s)mkfs(\.|\s)/,
  /(^|\s)dd\s+if=.*of=\/dev\//,
  /(^|\s)>\s*\/dev\/sd[a-z]/,
];

export function isDangerousBash(command: string): boolean {
  return DEFAULT_DENY_BASH.some((re) => re.test(command));
}

export async function loadSettings(configPath: string = DEFAULT_CONFIG_PATH): Promise<Settings> {
  let raw: unknown = {};
  try {
    const text = await readFile(configPath, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return settingsSchema.parse(raw);
}

export function parseSettings(raw: unknown): Settings {
  return settingsSchema.parse(raw);
}

export async function saveSettings(
  patch: Partial<Settings>,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<void> {
  let raw: Record<string, unknown> = {};
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const merged = { ...raw, ...patch };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}
