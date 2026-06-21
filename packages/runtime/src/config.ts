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

// MCP (Model Context Protocol) servers. Each entry is keyed by a short server
// name; the tools it exposes are surfaced to the model as `mcp__<name>__<tool>`.
// Two transports: a local subprocess speaking stdio, or a remote http/sse
// endpoint. `type` defaults to "stdio", so the common `{ command, args }` form
// needs no discriminator.
export const mcpStdioServerSchema = z.object({
  type: z.literal("stdio").default("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
});

export const mcpHttpServerSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
});

export const mcpServerSchema = z.union([mcpStdioServerSchema, mcpHttpServerSchema]);

// User-configurable shell hooks. Each entry runs a shell command at a given
// lifecycle event, bridged onto the in-code HookRegistry by the CLI. `matcher`
// is a regex tested against the tool name (only meaningful for the *ToolUse
// events; ignored by UserPromptSubmit / Stop); omitting it matches every tool.
// The command receives event context as a single JSON object on stdin (the
// Claude Code convention) and runs inside the same OS sandbox as the `bash` tool.
export const hookCommandSchema = z.object({
  matcher: z
    .string()
    .min(1)
    .optional()
    .describe("Regex matched against the tool name; omitted matches all tools."),
  command: z.string().min(1).describe("Shell command to run (via `bash -lc`)."),
  timeout_ms: z.number().int().positive().max(600_000).default(60_000),
});

export type HookCommandConfig = z.infer<typeof hookCommandSchema>;

// The `hooks` section, extracted so standalone project/local hook files
// (`.nova/hooks.json`, `.nova/hooks.local.json`) can be parsed with the same
// schema and accumulated onto the global config (see `mergeHooks`).
export const hooksConfigSchema = z.object({
  enabled: z.boolean().default(true),
  PreToolUse: z.array(hookCommandSchema).default([]),
  PostToolUse: z.array(hookCommandSchema).default([]),
  UserPromptSubmit: z.array(hookCommandSchema).default([]),
  Stop: z.array(hookCommandSchema).default([]),
  // Lifecycle events (advisory side effects; matcher tests the source/trigger):
  //   - SessionStart: matcher = startup | resume | clear
  //   - SessionEnd:   matcher = exit
  //   - PreCompact / PostCompact: matcher = auto | manual
  SessionStart: z.array(hookCommandSchema).default([]),
  SessionEnd: z.array(hookCommandSchema).default([]),
  PreCompact: z.array(hookCommandSchema).default([]),
  PostCompact: z.array(hookCommandSchema).default([]),
});

export type HooksConfig = z.infer<typeof hooksConfigSchema>;

/** Event keys carrying hook arrays (everything in HooksConfig except `enabled`). */
export const HOOK_EVENT_NAMES = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export type McpStdioServerConfig = z.infer<typeof mcpStdioServerSchema>;
export type McpHttpServerConfig = z.infer<typeof mcpHttpServerSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const DEFAULT_MEMORY_FILENAMES = ["NOVA.md", "CLAUDE.md", "AGENTS.md"] as const;

// Common package-manager / toolchain cache dirs that live OUTSIDE the
// workspace. Seeded into the sandbox write-allowlist so the default-ON sandbox
// doesn't break the everyday commands an agent runs — npm/pnpm/yarn, cargo +
// rustup, go, pip, etc. `~` is expanded by the sandbox SDK; entries that don't
// exist on a given platform simply never match (macOS Library/* vs Linux
// XDG paths are both listed). Setting `sandbox.filesystem.allowWrite`
// explicitly replaces this list.
export const DEFAULT_SANDBOX_ALLOW_WRITE = [
  "~/.npm", // npm cache + config
  "~/.cache", // XDG cache (pip, yarn, go-build, pnpm, … on Linux)
  "~/Library/Caches", // macOS cache (pip, go-build, …)
  "~/.cargo", // Rust crates / registry / bin
  "~/.rustup", // Rust toolchains
  "~/go", // Go GOPATH (modules + bin)
  "~/.local/share/pnpm", // pnpm store/bin (Linux)
  "~/Library/pnpm", // pnpm store/bin (macOS)
  "~/.yarn", // yarn global
] as const;

// A single price-table entry: USD per 1,000,000 tokens for a model whose id
// contains `match` (case-insensitive substring). `cacheRead` / `cacheWrite`
// are optional — when omitted they fall back to `input` (i.e. no cache
// discount/premium assumed), so a minimal `{ match, input, output }` works for
// providers that don't price cache tokens separately.
export const modelPriceSchema = z.object({
  match: z.string().min(1).describe("Case-insensitive substring tested against the active model id."),
  input: z.number().nonnegative().describe("Price per 1M uncached input tokens."),
  output: z.number().nonnegative().describe("Price per 1M output tokens."),
  cacheRead: z.number().nonnegative().optional().describe("Price per 1M cache-read tokens; defaults to `input`."),
  cacheWrite: z.number().nonnegative().optional().describe("Price per 1M cache-write tokens; defaults to `input`."),
  currency: z.enum(["USD", "CNY"]).optional().describe("Display currency for these rates; defaults to USD."),
});

export type ModelPriceConfig = z.infer<typeof modelPriceSchema>;

/** A fully-specified price-table entry (all four rates present). */
export interface ModelPriceDefault {
  match: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Display currency; omitted means USD. */
  currency?: "USD" | "CNY";
}

// Built-in price table consulted by `/usage` AFTER the user's
// `pricing.models`, so user entries override these. Rates are per 1,000,000
// tokens; `currency` selects the display symbol (defaults to USD — there is no
// FX conversion, each entry is self-consistent in its own currency). These are
// public LIST prices at the time of writing and WILL drift as providers
// re-price — they exist only so cost shows up out of the box; set
// `pricing.models` in nova.config.json for anything authoritative. Entries are
// ordered specific → generic because the first substring match wins. For
// DeepSeek's context caching, `input` is the cache-miss price, `cacheRead` the
// cache-hit price, and there is no separate write premium (cacheWrite = input);
// the v4 models list-price in CNY.
export const DEFAULT_MODEL_PRICING: ModelPriceDefault[] = [
  { match: "deepseek-v4-flash", input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1, currency: "CNY" },
  { match: "deepseek-v4-pro", input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3, currency: "CNY" },
];

/** Default per-response output cap when neither the model profile nor the
 *  top-level override specifies one. 32768 suits Anthropic models; DeepSeek's
 *  Anthropic-compatible endpoint caps output at 8192 — set per-tier maxTokens
 *  for those tiers. */
export const DEFAULT_MAX_TOKENS = 32768;

/** Default context-window budget when the model profile doesn't set one. */
export const DEFAULT_CONTEXT_WINDOW_SIZE = 1_000_000;

/** Supported input/output modalities for a model tier. */
export const modelModalitiesSchema = z.object({
  input: z
    .array(z.enum(["text", "image"]))
    .nonempty()
    .default(["text"])
    .describe("Input modalities the model accepts (e.g. text, image)."),
});

export type ModelModalities = z.infer<typeof modelModalitiesSchema>;

// A named model "profile" / performance tier (flash / pro / …) in the `models`
// table. Every entry is an object; the `id` is the concrete model id sent to
// the provider. Per-tier overrides (maxTokens, contextWindowSize, baseURL,
// apiKey) are all honored — maxTokens and contextWindowSize fall back to
// DEFAULT_MAX_TOKENS / DEFAULT_CONTEXT_WINDOW_SIZE when not set.
export const modelProfileSchema = z.object({
  id: z.string().min(1).describe("Concrete model id sent to the provider."),
  description: z.string().min(1).optional().describe("One-line blurb shown in the /model picker."),
  contextWindowSize: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_CONTEXT_WINDOW_SIZE)
    .describe("Per-tier context-window budget (drives the status-line gauge and auto-compaction threshold)."),
  maxTokens: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_TOKENS)
    .describe("Per-tier per-response output cap."),
  baseURL: z.string().url().optional().describe("Per-tier endpoint override."),
  apiKey: z.string().min(1).optional().describe("Per-tier API key override."),
  modalities: modelModalitiesSchema.default({ input: ["text"] }),
});

export type ModelProfile = z.infer<typeof modelProfileSchema>;

/** A `models` table entry: a profile object keyed by tier name. */
export const modelEntrySchema = modelProfileSchema;

export type ModelEntry = z.infer<typeof modelEntrySchema>;

// Default performance tiers, so `/model` is usable out of the box without any
// config. DeepSeek-flavoured to match this build's tuning (the same two ids the
// built-in pricing table carries); override by setting `models` in
// nova.config.json — providing the key REPLACES this default wholesale.
export const DEFAULT_MODELS: Record<string, ModelProfile> = {
  flash: { id: "deepseek-v4-flash", maxTokens: 384_000, contextWindowSize: 1_000_000, modalities: { input: ["text"] } },
  pro: { id: "deepseek-v4-pro", maxTokens: 384_000, contextWindowSize: 1_000_000, modalities: { input: ["text"] } },
};

// One-line blurbs for the built-in tiers, shown next to each row in the /model
// picker. Keyed by the same names as DEFAULT_MODELS; a user `models` entry in
// profile-object form can override its own via `description`.
export const DEFAULT_MODEL_DESCRIPTIONS: Record<string, string> = {
  flash: "fast & cheap — everyday edits, quick Q&A",
  pro: "most capable — hard reasoning, long tasks",
};

// Default selected tier (a key into DEFAULT_MODELS) and provider endpoint —
// DeepSeek-flavoured to match this build's tuning. Exported so the setup
// provider templates can reference the same source of truth.
export const DEFAULT_MODEL_TIER = "pro";
export const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";

// Default goal-mode knobs (the object-level fallback when `goal` is absent).
// `evalModel` is intentionally omitted here so the schema default reuses the
// active main model; provider templates may pin it to a cheaper tier.
export const DEFAULT_GOAL = {
  enabled: true,
  maxContinuations: 25,
  maxEvalTurns: 15,
} as const;

export const settingsSchema = z.object({
  apiKey: z.string().min(1).optional(),
  model: z.string().default(DEFAULT_MODEL_TIER),
  // Named model tiers, e.g. { "flash": { id: "deepseek-v4-flash", ... }, "pro": { ... } }.
  // The `model` field above may be either a bare model id OR a key into this
  // table; resolveModelId() maps a name to its concrete id and passes unknown
  // names through unchanged, so existing single-id configs keep working.
  // Every value is a profile object carrying its own maxTokens / contextWindowSize
  // (and optionally baseURL / apiKey). Switch tiers at runtime with /model.
  // Defaults to DEFAULT_MODELS (flash/pro) so /model works with no config;
  // setting this key REPLACES that default wholesale.
  models: z.record(modelEntrySchema).default({ ...DEFAULT_MODELS }),
  baseURL: z.string().url().default(DEFAULT_BASE_URL),
  sessionDir: z.string().min(1).optional(),
  // When a single response is truncated by the `maxTokens` output cap
  // (stop_reason: "max_tokens"), the loop can re-prompt the model to continue
  // from where it left off instead of hard-stopping the whole turn. This caps
  // how many *consecutive* continuations are allowed before the loop gives up
  // and surfaces the max_tokens termination. 0 = disabled (hard-stop on the
  // first truncation, the legacy behavior). Especially relevant for DeepSeek,
  // whose endpoint caps output at 8192 and so trips this often on long replies.
  // (maxTokens itself now lives per-tier in `models` — see resolveMaxTokens().)
  maxTokensContinuations: z.number().int().nonnegative().default(3),
  maxTurns: z.number().int().positive().default(100),
  // Max tool executions to run concurrently within a single turn. Calls beyond
  // this cap queue and start as slots free up. 1 = fully sequential.
  toolConcurrency: z.number().int().positive().default(3),
  // Schema only — concrete tool-name defaults live with the layer that
  // registers those tools (apps/cli/src/permissions.ts). @nova/runtime must
  // not know about specific tool identifiers.
  permissions: z
    .object({
      defaultEffect: z.enum(["allow", "deny", "ask"]).default("ask"),
      rules: z.array(permissionRuleSchema).default([]),
      // Extra directories (beyond the workspace cwd) that file tools may touch
      // without a per-call prompt. Mirrors Claude Code's `--add-dir`. Relative
      // entries resolve against the workspace; each is canonicalized (realpath)
      // at startup so the containment check compares real on-disk paths. The
      // workspace cwd is always an allowed root and need not be listed here.
      additionalDirectories: z.array(z.string().min(1)).default([]),
    })
    .default({ defaultEffect: "ask", rules: [], additionalDirectories: [] }),
  transcript: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  // Cost estimation surfaced by `/usage`. Token counts are priced with the
  // first matching entry from `models` (user-defined, takes precedence) falling
  // back to the built-in DEFAULT_MODEL_PRICING table; a model that matches
  // neither shows tokens without a dollar figure. `models` defaults to empty —
  // the built-in table covers the common Claude / DeepSeek ids out of the box.
  // Set `enabled: false` to suppress cost output entirely.
  pricing: z
    .object({
      enabled: z.boolean().default(true),
      models: z.array(modelPriceSchema).default([]),
    })
    .default({ enabled: true, models: [] }),
  // Startup housekeeping: on every launch, delete session directories whose
  // last activity is older than maxAgeDays. Age is the newest mtime of a
  // session's history/transcript files (last *use*, not creation), so a
  // resumed-and-still-used old session stays alive. The active session is
  // always protected. Set enabled:false to keep sessions forever.
  sessionCleanup: z
    .object({
      enabled: z.boolean().default(true),
      maxAgeDays: z.number().int().positive().default(30),
    })
    .default({ enabled: true, maxAgeDays: 30 }),
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
  // Live token streaming: render the assistant's text/reasoning in the TUI as
  // it streams, instead of revealing it all at once when the turn lands. When
  // off, the spinner stays bare until the final message (token counts still
  // tick). Toggle at runtime with /stream.
  stream: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  // Terminal rendering behavior for the interactive TUI.
  terminal: z
    .object({
      // Synchronized Output (DEC private mode 2026): wrap each Ink frame write
      // in BSU/ESU so the terminal composites it atomically. Ink repaints by
      // erasing the previous frame and redrawing; without this guard a fast
      // stream (notably DeepSeek's long reasoning + spinner) shows the
      // half-erased intermediate state as flicker. Terminals that don't
      // implement 2026 ignore the sequence per the DEC convention, so this is
      // safe to leave on; disable only if a terminal mishandles it.
      syncOutput: z.boolean().default(true),
      // Park the real terminal cursor on the InputBox caret each frame (via
      // DECSC/DECRC + cursor move) so the cursor — and IME composition popups
      // anchored to it — follow typing instead of sitting at the home corner.
      // Disable only if a terminal mishandles save/restore-cursor.
      cursorFollow: z.boolean().default(true),
    })
    .default({ syncOutput: true, cursorFollow: true }),
  // Next-user-input prediction shown as the input box placeholder. The CLI
  // runs this once after each successful agent turn using the main model.
  predict: z
    .object({
      enabled: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(8000),
      maxChars: z.number().int().positive().default(300),
    })
    .default({ enabled: true, timeoutMs: 8000, maxChars: 300 }),
  // Goal mode (`/goal`): after each turn an evaluator AGENT judges whether the
  // user's success condition is met; if not, the REPL auto-continues with that
  // feedback until it is — or the continuation budget is exhausted. The judge
  // runs the full tool set (read/grep/bash/webfetch/…) to verify against the
  // live state, going through the normal permission prompts.
  goal: z
    .object({
      enabled: z.boolean().default(true),
      // Model tier (a key in `models`) or bare id the evaluator agent runs on.
      // Omit to reuse the active main model; a cheap/fast tier is recommended.
      evalModel: z.string().min(1).optional(),
      // Hard cap on consecutive auto-continuations, so an unsatisfiable goal
      // can't loop forever.
      maxContinuations: z.number().int().nonnegative().default(25),
      // Loop cap (turns) for one run of the evaluator agent's verification.
      maxEvalTurns: z.number().int().positive().default(15),
    })
    .default({ ...DEFAULT_GOAL }),
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
  // Custom agent definitions are markdown files scanned from project / user
  // roots (.nova/agents → .claude/agents; ~/.nova/agents → ~/.claude/agents),
  // mirroring `skills` / `slash` layering — project shadows user, built-ins
  // (general-purpose / explore / plan) always win.
  subagent: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().min(1).optional(),
      projectDirs: z.array(z.string().min(1)).optional(),
      userPaths: z.array(z.string().min(1)).optional(),
      extraDirs: z.array(z.string().min(1)).optional(),
      maxTurns: z.number().int().positive().default(100),
      // Per-response output cap for the sub-agent loop, tunable independently
      // of the top-level maxTokens. A sub-agent's final message is a single
      // consolidated report, so a small budget risks the loop's max_tokens
      // hard-stop. 32768 matches the top-level default; DeepSeek's
      // Anthropic-compatible endpoint caps output at 8192 — lower it there.
      maxTokens: z.number().int().positive().default(32768),
    })
    .default({ enabled: true, maxTurns: 100, maxTokens: 32768 }),
  // OS-level command sandbox (@anthropic-ai/sandbox-runtime). Opt-out
  // (default ON). When enabled, tools that spawn a subprocess (bash,
  // runLongRunningCommand) run inside a platform sandbox — macOS Seatbelt via
  // sandbox-exec, Linux bubblewrap — that confines filesystem *writes* to the
  // workspace roots (the same allowed roots the permission engine uses) plus a
  // few system defaults. Reads stay open and the network is UNRESTRICTED by
  // default; set `network.allowedDomains` to lock down outbound connections.
  // This is defense-in-depth layered on top of the permission engine, not a
  // replacement for it. Unsupported platforms (Windows) or missing host deps
  // (ripgrep; Linux also bubblewrap/socat) degrade silently to no sandboxing, so
  // default-ON is safe to ship. Common out-of-workspace caches
  // (npm/pnpm/cargo/go/…) are seeded into filesystem.allowWrite by default (see
  // DEFAULT_SANDBOX_ALLOW_WRITE) so the usual commands work; add more paths
  // there for anything else, or set `enabled: false` to turn the sandbox off
  // entirely.
  sandbox: z
    .object({
      enabled: z.boolean().default(true),
      // Capture sandbox violations (macOS: a `log stream` watcher) so blocked
      // writes are annotated onto a command's output. Harmless no-op when the
      // sandbox is inactive. Turn off to skip the watcher subprocess.
      monitorViolations: z.boolean().default(true),
      filesystem: z
        .object({
          // Paths the sandbox may write to, beyond the workspace roots (which
          // are always writable). Defaults to DEFAULT_SANDBOX_ALLOW_WRITE
          // (common package-manager caches); setting this REPLACES that list.
          // `~` is expanded by the SDK; macOS accepts globs, Linux needs
          // literal paths.
          allowWrite: z.array(z.string().min(1)).default([...DEFAULT_SANDBOX_ALLOW_WRITE]),
          // Paths to deny writes to even within an allowed root (e.g. ".env").
          denyWrite: z.array(z.string().min(1)).default([]),
          // Paths to deny reads from (reads are otherwise unrestricted).
          denyRead: z.array(z.string().min(1)).default([]),
          // The sandbox SDK ALWAYS force-denies a fixed set of dangerous paths
          // inside the workspace, even though the workspace root is writable:
          // `.git/hooks`, `.git/config`, `.vscode/`, `.idea/`,
          // `.claude/{commands,agents}`, and shell-rc / `.mcp.json` dotfiles.
          // These are baked into the SDK and not otherwise configurable — only
          // `.git/config` can be re-opened, via this flag (needed for
          // `git config --local`, `git remote set-url`, …). `.git/hooks` stays
          // blocked regardless. Default true so ordinary git workflows work;
          // set false to match the SDK's stricter default. To allow writing the
          // other protected paths, turn the sandbox off (`enabled: false`).
          allowGitConfig: z.boolean().default(true),
        })
        .default({
          allowWrite: [...DEFAULT_SANDBOX_ALLOW_WRITE],
          denyWrite: [],
          denyRead: [],
          allowGitConfig: true,
        }),
      // Network confinement: UNRESTRICTED by default (undefined). Set
      // `allowedDomains` to restrict outbound connections to a
      // domain allowlist; `deniedDomains` to block specific domains on top
      // of that. `filterRequest` (the SDK callback) is not exposed — it
      // can't be expressed in JSON. All other SDK NetworkConfig fields are
      // surfaced here; see the @anthropic-ai/sandbox-runtime docs for
      // details.
      network: z
        .object({
          allowedDomains: z.array(z.string().min(1)).default([]),
          deniedDomains: z.array(z.string().min(1)).default([]),
          allowUnixSockets: z.array(z.string().min(1)).optional(),
          allowAllUnixSockets: z.boolean().optional(),
          allowLocalBinding: z.boolean().optional(),
          allowMachLookup: z.array(z.string().min(1)).optional(),
          httpProxyPort: z.number().int().positive().optional(),
          socksProxyPort: z.number().int().positive().optional(),
          mitmProxy: z
            .object({
              socketPath: z.string().min(1),
              domains: z.array(z.string().min(1)).min(1),
            })
            .optional(),
          tlsTerminate: z
            .object({
              caCertPath: z.string().min(1).optional(),
              caKeyPath: z.string().min(1).optional(),
            })
            .optional(),
          parentProxy: z
            .object({
              http: z.string().min(1).optional(),
              https: z.string().min(1).optional(),
              noProxy: z.string().min(1).optional(),
            })
            .optional(),
        })
        .optional()
        .describe("Network confinement config; omit for unrestricted network (default)."),
    })
    .default({
      enabled: true,
      monitorViolations: true,
      filesystem: {
        allowWrite: [...DEFAULT_SANDBOX_ALLOW_WRITE],
        denyWrite: [],
        denyRead: [],
        allowGitConfig: true,
      },
    }),
  // Background commands launched with runLongRunningCommand. When a command
  // finishes while the agent is idle (REPL waiting for input),
  // autoContinueOnComplete wakes it with a continuation turn so it can react to
  // the result — the captured output is injected via the same notifier that
  // serves a still-running turn — instead of waiting for the next user message.
  // Off keeps the injection but only delivers it on the next user-triggered
  // turn. REPL-only: a headless (`-p`) run has no input loop to wake.
  longRunning: z
    .object({
      autoContinueOnComplete: z.boolean().default(true),
    })
    .default({ autoContinueOnComplete: true }),
  // LSP code intelligence. When enabled, the `lsp` tool talks to language
  // servers (over JSON-RPC/stdio) for definition, references, hover,
  // diagnostics, and symbol search. Servers are NOT installed by Nova — they
  // must already be on PATH (typescript-language-server, pyright-langserver,
  // gopls, rust-analyzer are auto-detected by default). `servers` overrides or
  // extends that built-in table, keyed by languageId; a server whose binary is
  // missing degrades silently to a normal "not installed" tool result. The tool
  // is read-only and auto-allowed by the permission engine.
  lsp: z
    .object({
      enabled: z.boolean().default(true),
      // Handshake (initialize) timeout per server, in ms.
      initTimeoutMs: z.number().int().positive().default(15_000),
      // Per-request timeout (definition, references, …), in ms.
      requestTimeoutMs: z.number().int().positive().default(15_000),
      // How long to wait for publishDiagnostics after opening a file, in ms.
      diagnosticsTimeoutMs: z.number().int().positive().default(3_000),
      // Override/extend the built-in server table. Each entry replaces the
      // default with the same languageId; unknown ones are appended.
      servers: z
        .array(
          z.object({
            languageId: z.string().min(1),
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
            extensions: z.array(z.string().min(1)).min(1),
          }),
        )
        .optional(),
    })
    .default({
      enabled: true,
      initTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      diagnosticsTimeoutMs: 3_000,
    }),
  // MCP servers connected at startup. Each server's tools are bridged into the
  // registry as `mcp__<server>__<tool>` and gated by the normal permission
  // engine (default-ask). A server that fails to connect is logged and skipped
  // — it never blocks startup. Disable a single server with `enabled: false`,
  // or the whole subsystem with `mcp.enabled: false`.
  mcp: z
    .object({
      enabled: z.boolean().default(true),
      servers: z.record(mcpServerSchema).default({}),
      // Per-tool-call timeout in milliseconds.
      timeoutMs: z.number().int().positive().default(60_000),
    })
    .default({ enabled: true, servers: {}, timeoutMs: 60_000 }),
  // Declarative shell automation bridged onto the in-code HookRegistry by the
  // CLI (apps/cli/src/user-hooks.ts). Event names mirror the familiar
  // PreToolUse / PostToolUse / UserPromptSubmit / Stop convention:
  //   - PreToolUse:      runs before a tool; non-zero exit DENIES the call
  //                      (stderr becomes the denial reason).
  //   - PostToolUse:     runs after a tool; stdout is appended to the tool
  //                      result fed back to the model, non-zero exit also
  //                      marks it as an error.
  //   - UserPromptSubmit: runs before the turn starts; stdout is appended to
  //                      the user input as context, non-zero exit ABORTS.
  //   - Stop:            runs after the turn ends (advisory, side-effect only).
  // Disable the whole subsystem with `hooks.enabled: false`.
  hooks: hooksConfigSchema.default({}),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * Resolve a model name — either a key in `settings.models` or a bare model id —
 * to the concrete id sent to the provider. Unknown names pass through unchanged,
 * so a raw id in `settings.model` (or a `--model <id>` override) still works
 * even with no `models` table.
 */
export function resolveModelId(settings: Settings, name: string): string {
  const entry = settings.models[name];
  if (entry === undefined) return name;
  return entry.id;
}

/**
 * The context-window budget in effect for a given model tier: the tier's own
 * `contextWindowSize` when set (profile-object form), else the top-level
 * `DEFAULT_CONTEXT_WINDOW_SIZE`. `name` is a tier key or a bare id; a bare id
 * also matches a profile tier that resolves to the same concrete model, so a
 * config with `model: "deepseek-v4-pro"` still picks up the "pro" tier's window.
 * The default value stays the single fallback and is never mutated, so this
 * can be called fresh at each read site as /model switches the active tier.
 */
export function resolveContextWindowSize(settings: Settings, name: string): number {
  const direct = settings.models[name];
  if (direct?.contextWindowSize) {
    return direct.contextWindowSize;
  }
  const id = resolveModelId(settings, name);
  for (const entry of Object.values(settings.models)) {
    if (entry.id === id && entry.contextWindowSize) {
      return entry.contextWindowSize;
    }
  }
  return DEFAULT_CONTEXT_WINDOW_SIZE;
}

/**
 * One-line description for a model tier, shown in the /model picker. Prefers a
 * profile entry's own `description`, then the built-in blurb for a known tier
 * name (flash/pro), and falls back to "" when there's nothing to show.
 */
export function modelDescription(settings: Settings, name: string): string {
  const entry = settings.models[name];
  if (entry?.description) return entry.description;
  return DEFAULT_MODEL_DESCRIPTIONS[name] ?? "";
}

/**
 * The per-response output cap in effect for a given model tier, resolved the
 * same way as {@link resolveContextWindowSize}: the tier's own `maxTokens`
 * first, then a same-id profile match, then {@link DEFAULT_MAX_TOKENS}.
 */
export function resolveMaxTokens(settings: Settings, name: string): number {
  const direct = settings.models[name];
  if (direct?.maxTokens) {
    return direct.maxTokens;
  }
  const id = resolveModelId(settings, name);
  for (const entry of Object.values(settings.models)) {
    if (entry.id === id && entry.maxTokens) {
      return entry.maxTokens;
    }
  }
  return DEFAULT_MAX_TOKENS;
}

/**
 * The input/output modalities for a given model tier, resolved the same way as
 * {@link resolveMaxTokens}: the tier's own `modalities` first, then a same-id
 * profile match, then a text-only fallback.
 */
export function resolveModelModalities(
  settings: Settings,
  name: string,
): ModelModalities {
  const direct = settings.models[name];
  if (direct?.modalities) return direct.modalities;
  const id = resolveModelId(settings, name);
  for (const entry of Object.values(settings.models)) {
    if (entry.id === id && entry.modalities) return entry.modalities;
  }
  return { input: ["text"] };
}

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

/** Project / local hook file paths, relative to the workspace root. */
export const PROJECT_HOOK_FILES = [".nova/hooks.json", ".nova/hooks.local.json"] as const;

export interface ProjectHooksResult {
  /** Successfully parsed project/local hook files, in load order. */
  loaded: { source: string; hooks: HooksConfig }[];
  /** Files that existed but failed to parse — surfaced, not silently dropped. */
  errors: { source: string; message: string }[];
}

/**
 * Load standalone hook files (`.nova/hooks.json`, `.nova/hooks.local.json`) from
 * a workspace. Missing files are skipped; malformed ones are collected in
 * `errors` rather than thrown, so one bad file can't brick startup or hide a
 * valid sibling.
 */
export async function loadProjectHooks(workspace: string): Promise<ProjectHooksResult> {
  const result: ProjectHooksResult = { loaded: [], errors: [] };
  for (const rel of PROJECT_HOOK_FILES) {
    const source = join(workspace, rel);
    let text: string;
    try {
      text = await readFile(source, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      result.errors.push({ source, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      result.loaded.push({ source, hooks: hooksConfigSchema.parse(JSON.parse(text)) });
    } catch (err) {
      result.errors.push({ source, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Accumulate hooks across sources (global → project → local). Arrays are
 * concatenated, not overridden, so every source's hooks run; entries identical
 * in `(matcher, command)` are de-duplicated (first wins) to avoid double-runs
 * when the same hook is declared in two files. `enabled` is the AND of all
 * sources, so any source can opt its scope out.
 */
export function mergeHooks(sources: HooksConfig[]): HooksConfig {
  const merged = hooksConfigSchema.parse({});
  merged.enabled = sources.every((s) => s.enabled);
  for (const event of HOOK_EVENT_NAMES) {
    const seen = new Set<string>();
    for (const src of sources) {
      for (const hook of src[event]) {
        const key = `${hook.matcher ?? ""} ${hook.command}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged[event].push(hook);
      }
    }
  }
  return merged;
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
