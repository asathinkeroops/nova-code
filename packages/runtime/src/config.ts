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

export const settingsSchema = z.object({
  apiKey: z.string().min(1).optional(),
  model: z.string().default("claude-sonnet-4-5"),
  baseURL: z.string().url().optional(),
  sessionDir: z.string().min(1).optional(),
  // Per-response output cap. 32768 suits the default Claude model, which can
  // emit long single turns (writing a file, a thorough report) without tripping
  // the loop's max_tokens hard-stop. DeepSeek's Anthropic-compatible endpoint
  // caps output at 8192 — DeepSeek users should lower this in nova.config.json.
  maxTokens: z.number().int().positive().default(32768),
  contextWindowTokens: z.number().int().positive().default(1_000_000),
  maxTurns: z.number().int().positive().default(40),
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
  // Next-user-input prediction shown as the input box placeholder. The CLI
  // runs this once after each successful agent turn using the main model.
  predict: z
    .object({
      enabled: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(8000),
      maxChars: z.number().int().positive().default(50),
    })
    .default({ enabled: true, timeoutMs: 8000, maxChars: 50 }),
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
      maxTurns: z.number().int().positive().default(50),
      // Per-response output cap for the sub-agent loop, tunable independently
      // of the top-level maxTokens. A sub-agent's final message is a single
      // consolidated report, so a small budget risks the loop's max_tokens
      // hard-stop. 32768 matches the top-level default; DeepSeek's
      // Anthropic-compatible endpoint caps output at 8192 — lower it there.
      maxTokens: z.number().int().positive().default(32768),
    })
    .default({ enabled: true, maxTurns: 50, maxTokens: 32768 }),
  // OS-level command sandbox (@anthropic-ai/sandbox-runtime). Opt-out
  // (default ON). When enabled, tools that spawn a subprocess (bash,
  // runLongRunningCommand) run inside a platform sandbox — macOS Seatbelt via
  // sandbox-exec, Linux bubblewrap — that confines filesystem *writes* to the
  // workspace roots (the same allowed roots the permission engine uses) plus a
  // few system defaults. Reads stay open and the network is left UNRESTRICTED
  // (only the filesystem is enforced). This is defense-in-depth layered on top
  // of the permission engine, not a replacement for it. Unsupported platforms
  // (Windows) or missing host deps (ripgrep; Linux also bubblewrap/socat)
  // degrade silently to no sandboxing, so default-ON is safe to ship. Common
  // out-of-workspace caches (npm/pnpm/cargo/go/…) are seeded into
  // filesystem.allowWrite by default (see DEFAULT_SANDBOX_ALLOW_WRITE) so the
  // usual commands work; add more paths there for anything else, or set
  // `enabled: false` to turn the sandbox off entirely.
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
