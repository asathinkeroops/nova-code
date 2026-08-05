import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

// OAuth 2.0 (authorization-code + PKCE) for remote servers that gate access
// behind a 401. Add `oauth: {}` to a server to enable it (scopes optional);
// the first `/mcp auth <server>` opens a browser, and tokens persist under
// `~/.nova/mcp-auth/` so later sessions refresh silently.
export const mcpOAuthSchema = z.object({
  scope: z.string().min(1).optional(),
});

export const mcpHttpServerSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  oauth: mcpOAuthSchema.optional(),
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

// Global root under the user's home for the agent-maintained auto-memory store,
// organized by project (mirrors ~/.nova/sessions and Claude Code's scheme): each
// project gets its own subdirectory keyed by an encoded absolute path.
//
// It lives in the user's HOME rather than the repo on purpose. Auto-memory is
// *personalized* memory — facts the agent accumulated during one person's use,
// carrying their preferences and context — NOT the *standardized/shared* memory
// that the static NOVA.md/CLAUDE.md/AGENTS.md bundle provides (that layer is
// git-tracked, team-wide, and belongs in the repo). Committing personal memory
// into a shared repo would mis-frame it as unified team knowledge, so it stays
// per-user (never shared) yet per-project (kept isolated) — the same rationale
// as sessions living under ~/.nova/sessions. Do NOT "fix" this back into the
// workspace. `settings.memory.auto.dir` is the deliberate opt-out: an explicit,
// workspace-relative path for a project that genuinely wants a git-tracked store.
export const AUTO_MEMORY_ROOT_SEGMENTS = [".nova", "projects"] as const;

// Encode an absolute workspace path into a single filesystem-safe directory
// segment, matching Claude Code (every non-alphanumeric char becomes "-"): e.g.
// /Users/me/dev/app -> -Users-me-dev-app. Two real sibling projects can only
// collide if their paths differ solely in punctuation, which doesn't happen.
export function encodeProjectPath(workspace: string): string {
  return resolve(workspace).replace(/[^a-zA-Z0-9]/g, "-");
}

// Default per-project auto-memory directory: ~/.nova/projects/<encoded>/memory.
export function defaultAutoMemoryDir(workspace: string, home: string = homedir()): string {
  return join(home, ...AUTO_MEMORY_ROOT_SEGMENTS, encodeProjectPath(workspace), "memory");
}

// Resolve the effective auto-memory directory: an explicit `dir` override wins
// (resolved relative to the workspace, so absolute values pass through), else the
// default global per-project location under the user's home.
export function resolveAutoMemoryDir(
  workspace: string,
  dir?: string,
  home: string = homedir(),
): string {
  return dir ? resolve(workspace, dir) : defaultAutoMemoryDir(workspace, home);
}

// The MEMORY.md index is injected into the system prompt on EVERY request, so an
// unbounded index would silently grow per-request token cost as memories pile
// up. Cap the injected index at this many entries (it's one line per memory);
// the full file is always readable on demand via its baseDir.
export const DEFAULT_AUTO_MEMORY_MAX_ENTRIES = 100;

// Common package-manager / toolchain cache dirs that live OUTSIDE the
// workspace. Seeded into the sandbox write-allowlist so the sandbox (when
// enabled) doesn't break the everyday commands an agent runs — npm/pnpm/yarn, cargo +
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
  "~/.config/gh", // gh CLI auth/token refresh (git/PR workflow)
] as const;

// Per-1M-token prices for a single model tier, attached to its entry in the
// `models` table (see `modelProfileSchema.pricing`). This is the sole home for
// prices — there is no separate substring-matched price table. `cacheRead` /
// `cacheWrite` are optional: omitted, they fall back to the uncached `input`
// rate (no cache discount/premium assumed), so a minimal `{ input, output }`
// works for providers that don't price cache tokens separately. Rates are plain
// numbers per 1,000,000 tokens; `currency` only selects the display symbol
// (no FX conversion — each tier is self-consistent in its own currency).
export const modelPricingSchema = z.object({
  input: z.number().nonnegative().describe("Price per 1M uncached (cache-miss) input tokens."),
  output: z.number().nonnegative().describe("Price per 1M output tokens."),
  cacheRead: z
    .number()
    .nonnegative()
    .optional()
    .describe("Price per 1M cache-read (cache-hit) tokens; defaults to `input`."),
  cacheWrite: z
    .number()
    .nonnegative()
    .optional()
    .describe("Price per 1M cache-write tokens; defaults to `input`."),
  currency: z
    .enum(["USD", "CNY"])
    .optional()
    .describe("Display currency for these rates; defaults to USD."),
});

export type ModelPricing = z.infer<typeof modelPricingSchema>;

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

/** Discrete extended-thinking levels, shared by the global `thinking.level`
 *  setting and the per-tier `thinking` override in a model profile. Mirrors
 *  @nova/core's THINKING_LEVELS (runtime is a leaf and can't import core). */
export const thinkingLevelSchema = z.enum(["off", "low", "medium", "high", "max"]);

export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

/** Reasoning depth for a model that doesn't pin its own: the fallback used for
 *  bare model ids and any tier profile that omits `thinking`. Thinking is a
 *  per-tier property (there is no global `thinking` setting), so this is the
 *  only floor. "max" preserves the historical default. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "max";

// A named model "profile" / performance tier (lite / pro / max) in the `models`
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
    .describe(
      "Per-tier context-window budget (drives the status-line gauge and auto-compaction threshold).",
    ),
  maxTokens: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_TOKENS)
    .describe("Per-tier per-response output cap."),
  baseURL: z.string().url().optional().describe("Per-tier endpoint override."),
  apiKey: z.string().min(1).optional().describe("Per-tier API key override."),
  // Per-tier reasoning depth: selecting this tier sets the active thinking
  // level (the CLI seeds ctx.thinkingLevel from it on startup and on /model
  // switch, so /effort can still override within a session). Omitted → the
  // tier inherits the global `thinking.level`. This is what makes lite/pro/max
  // a real capability ladder on a single model id.
  thinking: thinkingLevelSchema
    .optional()
    .describe(
      "Per-tier extended-thinking level; falls back to the global thinking.level when unset.",
    ),
  modalities: modelModalitiesSchema.default({ input: ["text"] }),
  // Per-tier token prices for the `/usage` cost estimate and the status-line
  // cost segment. Attached to the tier (not a substring table) so the concrete
  // model's rates are unambiguous. Omit to show tokens without a dollar figure.
  pricing: modelPricingSchema
    .optional()
    .describe("Per-1M-token prices for /usage cost; omit to show tokens without a cost figure."),
});

export type ModelProfile = z.infer<typeof modelProfileSchema>;

/** A `models` table entry: a profile object keyed by tier name. */
export const modelEntrySchema = modelProfileSchema;

export type ModelEntry = z.infer<typeof modelEntrySchema>;

// One-line blurbs for the built-in tiers, shown next to each row in the /model
// picker. Keyed by tier name (lite/pro/max); a user `models` entry in
// profile-object form can override its own via `description`. Falls back to ""
// for any tier name not listed here, so third-party providers are unaffected.
export const DEFAULT_MODEL_DESCRIPTIONS: Record<string, string> = {
  lite: "fast & cheap — everyday edits, quick Q&A (light thinking)",
  pro: "balanced — most coding & reasoning, the default (deep thinking)",
  max: "most capable — hardest reasoning, long tasks (max thinking)",
};

// The tier a templated provider selects by default (a key into the `models`
// table that provider writes). DeepSeek-flavoured to match this build's tuning;
// exported so the setup provider templates reference one source of truth.
export const DEFAULT_MODEL_TIER = "pro";
// Cheapest built-in tier — the sensible default for auxiliary, latency- and
// cost-sensitive model calls (e.g. the auto-mode command classifier) that don't
// need the main `pro` tier. Only meaningful when `models` actually carries it;
// a config whose `models` omits this key must fall back to the main model.
export const DEFAULT_CHEAP_TIER = "lite";

// The fixed tier ladder. Every configured `models` table MUST define all three
// rungs (see the schema refine) so `/model lite|pro|max`, DEFAULT_CHEAP_TIER and
// the goal-mode eval tier always resolve — regardless of provider. A table may
// carry extra tiers on top, but never fewer. (An empty table is the one
// exception: it means "unconfigured", tolerated so setup can run first.)
export const REQUIRED_MODEL_TIERS = ["lite", "pro", "max"] as const;

// Default goal-mode knobs (the object-level fallback when `goal` is absent).
// `evalModel` is intentionally omitted here so the schema default reuses the
// active main model; provider templates may pin it to a cheaper tier.
export const DEFAULT_GOAL = {
  enabled: true,
  maxContinuations: 25,
  maxEvalTurns: 15,
} as const;

// Where a plugin (or a plugin marketplace) is fetched from. A bare string is a
// shorthand — a local filesystem path, or an `owner/repo` GitHub slug. The
// object form is explicit; unknown fields are preserved (Claude Code parity).
export const pluginSourceSchema = z.union([
  z.string().min(1),
  z
    .object({
      source: z.enum(["github", "git", "path", "npm"]),
      repo: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      package: z.string().min(1).optional(),
      ref: z.string().min(1).optional(),
      version: z.string().min(1).optional(),
    })
    .passthrough(),
]);

export type PluginSource = z.infer<typeof pluginSourceSchema>;

export const settingsSchema = z.object({
  apiKey: z.string().min(1).optional(),
  // The active tier: a KEY into `models` (lite/pro/max), never a bare model id.
  // Enforced by the schema-level refine below — a value that isn't a configured
  // tier is a config error (skipped only while `models` is still empty, i.e. an
  // unconfigured config pre-setup). Tier → concrete id resolution is alias-only
  // (resolveModelId); switch at runtime with /model. The default is a
  // placeholder that a chosen provider template (or the user's config)
  // overwrites alongside `models`.
  model: z.string().default(DEFAULT_MODEL_TIER),
  // Named model tiers, e.g. { "lite": { id: "deepseek-v4-flash", ... }, "pro": { ... } }.
  // Every value is a profile object carrying its own maxTokens / contextWindowSize
  // / thinking (and optionally baseURL / apiKey). Distinct tiers may share one
  // concrete `id` and differ only in their per-tier knobs (e.g. pro/max both →
  // deepseek-v4-pro, differing in `thinking`), which is why all tier lookups are
  // keyed by the alias, never reverse-mapped from the id. No schema default:
  // the tier set is provider-specific, so it is only populated when a provider
  // template is chosen (DeepSeek writes lite/pro/max — see provider-templates.ts)
  // or when the user hand-authors a config. An empty table means "unconfigured".
  models: z.record(modelEntrySchema).default({}),
  // No schema default: the base endpoint is provider-specific, so it is only
  // written when a provider template is chosen (or the user sets it). Callers
  // treat an absent value as "use the SDK's own default endpoint" — see the
  // `config.baseURL ? …` guards in model.ts / context.ts. The DeepSeek setup
  // template writes its own endpoint explicitly (see provider-templates.ts).
  baseURL: z.string().url().optional(),
  // Which provider profile drives thinking-param and error/retry behavior.
  // "deepseek" — DeepSeek's Anthropic-compatible endpoint (effort knob,
  // translated error diagnostics, transient-status retry). "other" — any generic
  // Anthropic-compatible endpoint (budget_tokens, no error translation, no
  // status-based retry). Free-form string, not an enum: the profile registry is
  // the single source of truth for the id set, and it lives in `@nova/core` —
  // which this leaf package can't import to enumerate. `@nova/core`'s
  // `resolveProfile` maps an unknown id (a typo, or a generic provider named
  // directly) to the `other` fallback; `nova doctor` flags ids that aren't a
  // built-in. Always present (defaults to "deepseek", this build's primary
  // target), so downstream never has to guess a profile from the model name.
  provider: z.string().min(1).default("deepseek"),
  sessionDir: z.string().min(1).optional(),
  // UI / response language. "auto" (the default) follows the current system
  // locale (resolved from $LANG / $LC_ALL / $LANGUAGE, see resolveLanguage());
  // any other value is a BCP-47-ish language tag (e.g. "en", "zh-CN") used
  // verbatim. Stored as a free string so new locales need no schema change.
  // This drives the MODEL's response language (it is injected into the system
  // prompt) and, by default, the TUI's static text — unless `locale` overrides.
  language: z.string().min(1).default("auto"),
  // TUI-only locale override for the interface's static text (menus, prompts,
  // status line, …). "auto" (the default) means "follow `language`"; any other
  // value is a BCP-47-ish tag (e.g. "en", "zh-CN") applied to the UI *only* —
  // it never enters the system prompt, so it can differ from the model's
  // response language (e.g. English replies with a Chinese interface). An
  // unsupported tag falls back to English, same rule as `language`. The
  // precedence (locale → language) lives in the CLI's setLocale().
  locale: z.string().min(1).default("auto"),
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
      // Bare-name tool denylist (mirrors Claude Code's bare `WebSearch` deny):
      // each name here is unregistered from the tool registry at startup, so the
      // tool never appears in the request's `tools` array and the model cannot
      // call it. This is the stronger "the model never sees it" form of deny —
      // contrast a `rules` entry with `effect: "deny"`, which keeps advertising
      // the tool and only rejects calls at dispatch time (and can match on
      // input). Names are wire tool identifiers (e.g. "websearch", "webfetch",
      // "bash", or an MCP "mcp__server__tool"); unknown names are ignored.
      deny: z.array(z.string().min(1)).default([]),
      // Extra directories (beyond the workspace cwd) that file tools may touch
      // without a per-call prompt. Mirrors Claude Code's `--add-dir`. Relative
      // entries resolve against the workspace; each is canonicalized (realpath)
      // at startup so the containment check compares real on-disk paths. The
      // workspace cwd is always an allowed root and need not be listed here.
      additionalDirectories: z.array(z.string().min(1)).default([]),
      // The `auto` permission mode (shift+tab) runs commands (bash,
      // runInBackground) unattended, gated by a command-risk classifier:
      // static rules block clearly destructive commands and fast-path clearly
      // read-only ones; whatever the rules can't decide goes to an LLM
      // classifier. A command judged risky falls back to a confirmation prompt
      // (it is never silently run). Mirrors Claude Code's auto-mode classifier.
      autoMode: z
        .object({
          // Send rule-undecided commands to the LLM classifier. Off → rules
          // only: every undecided command falls back to a prompt (no model
          // call, zero added latency/tokens, but far more prompts).
          llmClassifier: z.boolean().default(true),
          // Model the classifier runs on — a bare model id or a key into
          // `models`. Independent of the agent's `/model`, mirroring Claude
          // Code's separate classifier model: a small/cheap/fast model so
          // safety checks don't pay main-model latency or cost. Unset → the
          // cheap built-in tier (DEFAULT_CHEAP_TIER, "flash") when `models`
          // still carries it, otherwise the active main model.
          model: z.string().min(1).optional(),
          // Budget for the LLM classifier call. On timeout the command is
          // treated as risky (fail-closed) and prompts rather than running.
          classifierTimeoutMs: z.number().int().positive().default(8000),
        })
        .default({ llmClassifier: true, classifierTimeoutMs: 8000 }),
    })
    .default({
      defaultEffect: "ask",
      rules: [],
      deny: [],
      additionalDirectories: [],
      autoMode: { llmClassifier: true, classifierTimeoutMs: 8000 },
    }),
  // Workspace trust. On startup nova checks whether the workspace it was
  // launched in has been granted file access; an untrusted workspace prompts
  // the user to confirm, and declining exits. Trust is recorded HERE (in the
  // user-global config, which a project cannot write) rather than in any
  // project-checked-in file — mirroring Claude Code's `~/.claude.json` model,
  // so a cloned repo can never mark itself trusted. `trustedRoots` are absolute
  // canonical paths; a workspace equal to or nested under any of them is
  // trusted (so trusting a repo root covers its subdirectories). Users may
  // pre-seed roots by hand. Set `enabled: false` to restore the legacy
  // "workspace is always trusted on launch" behavior.
  trust: z
    .object({
      enabled: z.boolean().default(true),
      trustedRoots: z.array(z.string().min(1)).default([]),
    })
    .default({ enabled: true, trustedRoots: [] }),
  transcript: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  // Cost estimation surfaced by `/usage` and the status-line cost segment.
  // Prices live per-tier on `models.<tier>.pricing` (see modelPricingSchema);
  // the active tier's rates are used, and a tier without `pricing` shows tokens
  // without a dollar figure. This is just the on/off toggle — set
  // `enabled: false` to suppress cost output entirely.
  pricing: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
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
  // Auto-update: a non-blocking startup check against npm, plus the `nova
  // upgrade` command's installer. `command` is overridable so pnpm/yarn/bun
  // global installs work. Set enabled:false to silence the check entirely.
  // `autoInstall` (default on) runs `command` in the background as soon as a
  // newer version is published; the running process keeps its already-loaded
  // code, so the new version takes effect on the NEXT launch. Set it false to
  // go back to notify-only.
  update: z
    .object({
      enabled: z.boolean().default(true),
      autoInstall: z.boolean().default(true),
      notifyIntervalHours: z.number().int().positive().default(6),
      command: z.string().default("npm install -g @asathinkeroops/nova-code@latest"),
    })
    .default({
      enabled: true,
      autoInstall: true,
      notifyIntervalHours: 6,
      command: "npm install -g @asathinkeroops/nova-code@latest",
    }),
  logging: z
    .object({
      level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
      pretty: z.boolean().default(true),
    })
    .default({ level: "info", pretty: true }),
  // Extended-thinking depth is NOT a global setting — it lives per model tier
  // (`models.<tier>.thinking`), seeded into the active session on startup and on
  // /model switch. /effort adjusts it in-session (and persists into the active
  // tier); bare ids / tiers that omit it fall back to DEFAULT_THINKING_LEVEL.
  memory: z
    .object({
      filenames: z
        .array(z.string().min(1))
        .nonempty()
        .default([...DEFAULT_MEMORY_FILENAMES]),
      userPaths: z.array(z.string().min(1)).optional(),
      globalPath: z.string().min(1).optional(),
      // Cross-session memory the agent maintains itself: an index (MEMORY.md)
      // plus one file per fact, loaded as the `auto` memory layer. It lives in
      // the global per-project store (~/.nova/projects/<encoded>/memory) unless
      // `dir` overrides it — see resolveAutoMemoryDir.
      auto: z
        .object({
          enabled: z.boolean().default(true),
          // Optional explicit override for the store location, resolved relative
          // to the workspace root (absolute values pass through). Unset — the
          // default — uses the global per-project directory under ~/.nova.
          dir: z.string().min(1).optional(),
          // Max memory entries (lines) from MEMORY.md injected into the prompt.
          maxEntries: z.number().int().positive().default(DEFAULT_AUTO_MEMORY_MAX_ENTRIES),
        })
        .default({
          enabled: true,
          maxEntries: DEFAULT_AUTO_MEMORY_MAX_ENTRIES,
        }),
    })
    .default({
      filenames: [...DEFAULT_MEMORY_FILENAMES],
      auto: {
        enabled: true,
        maxEntries: DEFAULT_AUTO_MEMORY_MAX_ENTRIES,
      },
    }),
  // compact overrides — tuning fields are optional and default to the constants
  // in @nova/context/compact.ts (single source of truth). `enabled` is a
  // runtime concern (whether to invoke compact at all) so it defaults here.
  //
  // auto_compact APPENDS a `<compacted>` summary boundary to the append-only
  // history (never truncating it): the full history stays on disk and in the
  // TUI, while the model is fed only the slice from the last boundary onward.
  compact: z
    .object({
      auto: z
        .object({
          enabled: z.boolean().default(true),
          thresholdTokens: z.number().int().positive().optional(),
          contextWindowPercent: z.number().positive().max(1).optional(),
          maxSummaryTokens: z.number().int().positive().optional(),
        })
        .default({ enabled: true }),
    })
    .default({ auto: { enabled: true } }),
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
      // Per-agent model selection, keyed by sub-agent name (e.g. "plan",
      // "explore", "general-purpose", "nova-code-guide", or any custom agent).
      // Values are tier keys (lite/pro/max) or bare provider ids — the same
      // space as the top-level `model`. Resolution precedence, most specific
      // first (see getSubagentModel): this map's per-name entry → the shipped
      // built-in default for that agent (general-purpose/plan → max, explore/
      // nova-code-guide → pro) → a custom agent's own `model` frontmatter → the
      // active main model. A per-name entry here overrides the built-in default,
      // one agent at a time — listing one agent does not disturb the others.
      // Omit entirely to leave every sub-agent on its default.
      model: z.record(z.string().min(1), z.string().min(1)).optional(),
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
  // Nova Code Guide: a read-only Q&A agent that answers questions about Nova
  // itself from a local checkout of the Nova source. The `/nova-code-guide`
  // command spawns a read-only sub-agent scoped to that checkout; enabled by
  // default but also gated on `subagent.enabled` (the guide runs as a
  // sub-agent).
  //
  // `source` picks where the source comes from:
  //   "remote" (default) — shallow-clone `repoUrl` (branch `ref`) into
  //       `cacheDir` and refresh it before each question. Answering history
  //       questions ("how did X evolve") is out of scope — the clone is shallow
  //       (--depth 1); only the current source is available.
  //   "local" — read directly from `localPath` (or the current workspace when
  //       unset); no clone/fetch. Use this when developing Nova itself so the
  //       guide answers from the code you're editing rather than upstream.
  guide: z
    .object({
      enabled: z.boolean().default(true),
      source: z.enum(["remote", "local"]).default("remote"),
      repoUrl: z.string().min(1).default("https://github.com/asathinkeroops/nova-code.git"),
      ref: z.string().min(1).default("main"),
      // Where the checkout is materialized (source: "remote"). `~` and relative
      // paths resolve against the home directory; the default sits beside
      // nova.config.json.
      cacheDir: z.string().min(1).default("~/.nova/nova-code-guide"),
      // Local Nova source dir (source: "local"). `~` expands to home; a relative
      // path resolves against the workspace cwd. When unset, the workspace cwd
      // itself is used — the common case when developing Nova in its own repo.
      localPath: z.string().min(1).optional(),
      // How often (hours) to refresh the remote checkout. An existing checkout
      // refreshed within this window is served as-is with no network fetch, so
      // the silent every-launch warm doesn't hit the network each time. 0
      // disables throttling (always fetch). Ignored for source: "local".
      refreshIntervalHours: z.number().nonnegative().default(24),
    })
    .default({
      enabled: true,
      source: "remote",
      repoUrl: "https://github.com/asathinkeroops/nova-code.git",
      ref: "main",
      cacheDir: "~/.nova/nova-code-guide",
      refreshIntervalHours: 24,
    }),
  // OS-level command sandbox (@anthropic-ai/sandbox-runtime). Opt-in
  // (default OFF). When enabled, tools that spawn a subprocess (bash,
  // runInBackground) run inside a platform sandbox — macOS Seatbelt via
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
  // there for anything else. The sandbox is OFF by default; set
  // `enabled: true` to turn it on.
  sandbox: z
    .object({
      enabled: z.boolean().default(false),
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
      enabled: false,
      monitorViolations: true,
      filesystem: {
        allowWrite: [...DEFAULT_SANDBOX_ALLOW_WRITE],
        denyWrite: [],
        denyRead: [],
        allowGitConfig: true,
      },
    }),
  // Todo checklist behavior. When every todo reaches status=completed the
  // checklist auto-clears after `autoClearDelayMs` — a short beat so the ✓'d
  // list stays on screen before it vanishes — instead of relying on the model
  // to call clearTodoList (which it routinely skips once it starts its final
  // summary). Set to 0 to disable auto-clear and hand the finished list back to
  // the model to clear itself.
  todo: z
    .object({
      autoClearDelayMs: z.number().int().nonnegative().default(2500),
    })
    .default({ autoClearDelayMs: 2500 }),
  // Task plan behavior. Mirror of `todo.autoClearDelayMs` for the persistent
  // task store: a fully-completed plan auto-clears (deleting its `.tasks/` files)
  // after this delay. 0 disables.
  task: z
    .object({
      autoClearDelayMs: z.number().int().nonnegative().default(2500),
    })
    .default({ autoClearDelayMs: 2500 }),
  // Background commands launched with runInBackground. When a command
  // finishes while the agent is idle (REPL waiting for input),
  // autoContinueOnComplete wakes it with a continuation turn so it can react to
  // the result — the captured output is injected via the same notifier that
  // serves a still-running turn — instead of waiting for the next user message.
  // Off keeps the injection but only delivers it on the next user-triggered
  // turn. REPL-only: a headless (`-p`) run has no input loop to wake.
  background: z
    .object({
      autoContinueOnComplete: z.boolean().default(true),
    })
    .default({ autoContinueOnComplete: true }),
  // Queued input handling. Prompts typed while a turn runs pile up in the input
  // queue and are normally drained one-per-turn back at the REPL once the turn
  // ends. When `consumeInLoop` is on, a running turn instead folds the next
  // queued prompt in *mid-task* — it's injected as a user message at the agent
  // loop's `pre_continue` boundary (between tool iterations), so the model reacts
  // without waiting for the current task to finish. Only plain prompts are
  // consumed this way; `/` slash and `!` shell lines stay queued for the REPL to
  // dispatch. Off restores the classic REPL-drained behavior.
  queue: z
    .object({
      consumeInLoop: z.boolean().default(true),
    })
    .default({ consumeInLoop: true }),
  // Recurring `/loop` command. `/loop <interval> <prompt|/cmd>` re-runs a payload
  // on a fixed schedule until `/loop stop` (or a session switch / exit). Iterations
  // are driven inline by the REPL between turns — a tick that comes due while a turn
  // is running fires as soon as the REPL is free, so ticks never overlap or pile up.
  // `maxIterations` is a safety cap (the loop stops and warns on reach);
  // `minIntervalMs` rejects too-tight intervals that would peg the model.
  loop: z
    .object({
      maxIterations: z.number().int().positive().default(100),
      minIntervalMs: z.number().int().positive().default(1000),
    })
    .default({ maxIterations: 100, minIntervalMs: 1000 }),
  // Scheduled tasks (the cronCreate/cronList/cronDelete tools, and the mechanism
  // `/loop` rides on). Entries persist under the session dir and re-arm on
  // /resume; they fire only while a session is live (no background daemon).
  // `enabled` gates only the agent-facing tools — `/loop` keeps working when off.
  // `maxSchedules` caps concurrent agent-created schedules; `minIntervalMs` and
  // `maxIterations` bound each schedule the same way `loop` does its own.
  cron: z
    .object({
      enabled: z.boolean().default(true),
      maxSchedules: z.number().int().positive().default(20),
      minIntervalMs: z.number().int().positive().default(1000),
      maxIterations: z.number().int().positive().default(100),
    })
    .default({ enabled: true, maxSchedules: 20, minIntervalMs: 1000, maxIterations: 100 }),
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
      // Loopback endpoint that catches the OAuth redirect during `/mcp auth`.
      // The port is fixed (not ephemeral) so the registered redirect_uri stays
      // stable across runs; change it only if it collides with another service.
      oauth: z
        .object({
          callbackHost: z.string().min(1).default("127.0.0.1"),
          callbackPort: z.number().int().min(1024).max(65_535).default(7777),
          // Mark any remote server that challenges with 401/403 as needs-auth
          // (offering `/mcp` → Authenticate), even without an explicit `oauth`
          // block. Servers using a static Authorization header are exempt.
          autoDetect: z.boolean().default(true),
        })
        .default({ callbackHost: "127.0.0.1", callbackPort: 7777, autoDetect: true }),
    })
    .default({
      enabled: true,
      servers: {},
      timeoutMs: 60_000,
      oauth: { callbackHost: "127.0.0.1", callbackPort: 7777, autoDetect: true },
    }),
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
  // Plugins: distributable bundles that package the existing extension types
  // (slash commands, sub-agents, skills, shell hooks, MCP servers) under one
  // directory + manifest, so a whole workflow can be shared and versioned as a
  // unit. Claude-Code-compatible layout: the manifest lives at
  // `.nova-plugin/plugin.json` (preferred) or `.claude-plugin/plugin.json`
  // (fallback, so stock Claude Code plugins load unchanged); component dirs
  // (commands/, agents/, skills/, hooks/hooks.json, .mcp.json) sit at the plugin
  // root. Discovery mirrors the other markdown loaders — project dirs before
  // user dirs, first-name-wins, built-ins always win. Default OFF (opt-in). Opt
  // a single installed plugin out by name via `disabled`.
  plugins: z
    .object({
      enabled: z.boolean().default(false),
      projectDirs: z.array(z.string().min(1)).default([".nova/plugins", ".claude/plugins"]),
      userDirs: z.array(z.string().min(1)).default(["~/.nova/plugins", "~/.claude/plugins"]),
      disabled: z.array(z.string().min(1)).default([]),
      // Plugins installed from a source into the cache (~/.nova/plugins/cache),
      // keyed by plugin name → the source they were fetched from. Written by
      // `/plugin install`; the cache dir is scanned at startup like any other.
      installed: z.record(pluginSourceSchema).default({}),
      // Registered plugin marketplaces (catalogs), keyed by marketplace name →
      // where its `marketplace.json` lives. Managed by `/plugin marketplace`.
      marketplaces: z.record(pluginSourceSchema).default({}),
    })
    .default({
      enabled: false,
      projectDirs: [".nova/plugins", ".claude/plugins"],
      userDirs: ["~/.nova/plugins", "~/.claude/plugins"],
      disabled: [],
      installed: {},
      marketplaces: {},
    }),
  })
  // Two tier-table invariants, both skipped while `models` is empty — that's an
  // unconfigured config (a fresh/missing file parsed before setup runs, which
  // loadSettings must not reject); setup then writes a populated table that both
  // checks apply to.
  .superRefine((val, ctx) => {
    if (Object.keys(val.models).length === 0) return;
    // (1) The fixed ladder must be complete: every config must define all of
    // lite/pro/max (extra tiers are fine) so tier switching and the built-in
    // cheap/eval tiers always resolve, whatever the provider.
    const missing = REQUIRED_MODEL_TIERS.filter(
      (t) => !Object.prototype.hasOwnProperty.call(val.models, t),
    );
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models"],
        message: `models must configure all tiers (${REQUIRED_MODEL_TIERS.join(
          ", ",
        )}) — missing: ${missing.join(", ")}`,
      });
    }
    // (2) The active `model` must name a configured tier (a key in `models`),
    // not a bare provider id — tier resolution is alias-only. A stray id here
    // would silently miss every per-tier lookup (maxTokens/contextWindow/
    // thinking/…), so reject it at the boundary with an actionable message.
    if (!Object.prototype.hasOwnProperty.call(val.models, val.model)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: `model "${val.model}" is not a configured tier — set it to one of: ${Object.keys(
          val.models,
        ).join(", ")}`,
      });
    }
  });

export type Settings = z.infer<typeof settingsSchema>;

/**
 * Resolve a model tier name to the concrete id sent to the provider. Tier
 * resolution is ALIAS-ONLY: `name` is expected to be a key in `settings.models`
 * (the main `model` is validated as such — see {@link settingsSchema}). A name
 * that isn't a configured tier passes through unchanged — this is the escape
 * hatch for the auxiliary model fields (`subagent.model` values, `goal.evalModel`,
 * `permissions.autoMode.model`) that may name a bare provider id directly; the
 * main `model` never hits it.
 */
export function resolveModelId(settings: Settings, name: string): string {
  return settings.models[name]?.id ?? name;
}

/**
 * The context-window budget for a model tier: the tier's own `contextWindowSize`
 * (always present — the profile schema defaults it), else
 * {@link DEFAULT_CONTEXT_WINDOW_SIZE} for a name that isn't a configured tier.
 * ALIAS-ONLY: matched by tier key, never by reverse-mapping a concrete id (tiers
 * can share one id, so id-matching would be ambiguous). The default is never
 * mutated, so this can be called fresh at each read site as /model switches.
 */
export function resolveContextWindowSize(settings: Settings, name: string): number {
  return settings.models[name]?.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW_SIZE;
}

/**
 * One-line description for a model tier, shown in the /model picker. Prefers a
 * profile entry's own `description`, then the built-in blurb for a known tier
 * name (lite/pro/max), and falls back to "" when there's nothing to show.
 */
export function modelDescription(settings: Settings, name: string): string {
  const entry = settings.models[name];
  if (entry?.description) return entry.description;
  return DEFAULT_MODEL_DESCRIPTIONS[name] ?? "";
}

/**
 * The per-response output cap for a model tier: the tier's own `maxTokens`
 * (always present — schema default), else {@link DEFAULT_MAX_TOKENS}.
 * ALIAS-ONLY, matched by tier key (see {@link resolveContextWindowSize}).
 */
export function resolveMaxTokens(settings: Settings, name: string): number {
  return settings.models[name]?.maxTokens ?? DEFAULT_MAX_TOKENS;
}

/**
 * The extended-thinking level for a model tier: the tier's own `thinking`, else
 * {@link DEFAULT_THINKING_LEVEL}. Thinking lives entirely per-tier (there is no
 * global setting), so this is the single source of the active reasoning depth.
 * ALIAS-ONLY, matched by tier key (see {@link resolveContextWindowSize}).
 */
export function resolveThinkingLevel(settings: Settings, name: string): ThinkingLevel {
  return settings.models[name]?.thinking ?? DEFAULT_THINKING_LEVEL;
}

/**
 * The input/output modalities for a model tier: the tier's own `modalities`
 * (always present — schema default), else a text-only fallback. ALIAS-ONLY,
 * matched by tier key (see {@link resolveContextWindowSize}).
 */
export function resolveModelModalities(settings: Settings, name: string): ModelModalities {
  return settings.models[name]?.modalities ?? { input: ["text"] };
}

/** Normalize a raw locale to a BCP-47-ish tag: take the part before any
 * `.charset` / `:`-separated extra locale and swap `_` → `-`
 * ("zh_CN.UTF-8" → "zh-CN"). Returns undefined for the no-preference locales
 * (unset, "C", "POSIX"). */
function normalizeLocale(raw: string | undefined): string | undefined {
  const tag = raw?.split(/[.:]/)[0]?.trim().replace(/_/g, "-");
  if (!tag || tag === "C" || tag === "POSIX") return undefined;
  return tag;
}

/** The macOS UI language (`AppleLocale`, e.g. "zh_CN"), read via `defaults`.
 * macOS keeps this OUTSIDE the POSIX env — a system set to Chinese still
 * commonly exports `LANG=C.UTF-8` — so env detection alone reports the wrong
 * language. Returns undefined off macOS or on any failure (missing binary,
 * timeout). Synchronous, but only called once at startup from resolveLanguage. */
function readMacOsLocale(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const out = execFileSync("defaults", ["read", "-g", "AppleLocale"], {
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective UI/response language. A non-"auto" `settings.language`
 * is returned verbatim. For "auto" (the default) the system locale is detected:
 * first the POSIX env ($LC_ALL → $LANG → $LANGUAGE; authoritative on Linux),
 * then — when that is unset or "C"/"POSIX" — the macOS UI language via
 * `AppleLocale`. Tags are normalized to a BCP-47-ish form ("zh_CN.UTF-8" →
 * "zh-CN"). Falls back to `fallback` (default "en") when nothing is detectable.
 */
export function resolveLanguage(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
  fallback = "en",
): string {
  if (settings.language !== "auto") return settings.language;
  const fromEnv = normalizeLocale(env.LC_ALL || env.LANG || env.LANGUAGE);
  if (fromEnv) return fromEnv;
  const fromMac = normalizeLocale(readMacOsLocale());
  if (fromMac) return fromMac;
  return fallback;
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
  const settings = settingsSchema.parse(raw);
  // Resolve "auto" to the concrete system locale once, at load, so every
  // downstream read sees a real language tag. Idempotent: a non-"auto" value
  // (already-resolved or user-set) passes through unchanged.
  settings.language = resolveLanguage(settings);
  return settings;
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
        const key = `${hook.matcher ?? ""}\u0000${hook.command}`;
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
