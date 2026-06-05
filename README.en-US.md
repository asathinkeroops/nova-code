# Nova

![Nova screenshot](snapshots/screen.png)

> A terminal coding agent, deeply tuned for DeepSeek.

Nova is a coding agent that lives in your terminal — reads code, runs commands, edits files, and drives a task to done through tool use. It speaks the Anthropic message shape internally, but the model layer is built around **DeepSeek**: thinking is wired to DeepSeek's `output_config.effort` (not Anthropic's `budget_tokens`), the wire format is auto-detected from the model id, the request shape and context-management defaults are kept **cache-friendly** so DeepSeek's automatic context cache keeps hitting, and the default prompts/permissions are tuned for DeepSeek's behavior. Other Anthropic-compatible endpoints still work — DeepSeek is the path that gets first-class care.

Under the hood Nova is a loop-centric harness: `@nova/core` exposes a model-agnostic agent loop and a **single `HookRegistry` extension point** — tools, permissions, context, observability, skills, and slash commands all attach through it. `@nova/agent` packages the loop into a per-turn `createAgent` with persistence and transcript wiring, and `apps/cli` is what you actually run — the `nova` binary, a full-screen Ink/React REPL with mouse scroll/selection and a live status line.

---

## Core capabilities

**What it does** — a complete agentic coding workbench:

- **Agentic coding loop** — reads code, edits files, runs commands, and drives a task to done through tool use; independent tool calls within a turn run with **bounded concurrency** (default 3).
- **Code & system tools** — file `read` (line-numbered + paginated) / `write` / `edit`, `glob` + `grep` search, `bash` (60s hard cap) and long-running commands via `runLongRunningCommand`, `webfetch` / `websearch`, notebook edit, `askUserQuestion`, and todo / task lists.
- **Sub-agents** — the model delegates work to **fresh-context** workers via `createSubAgent`; ships `explore` / `plan` / `general-purpose`, and lets you define arbitrary custom types with `.md` files.
- **LSP code intelligence** — an `lsp` tool that talks straight to language servers (JSON-RPC/stdio) for go-to-definition, find-references, hover, diagnostics, and symbol search — scope- and type-aware, far more precise than grep.
- **Memory** — CLAUDE.md-style project & user memory, per directory `NOVA.md` > `CLAUDE.md` > `AGENTS.md` (highest wins, no merging); `/init` generates or refreshes it in one step.
- **Skills** — `SKILL.md` files discovered on startup, indexed into the prompt, pulled in full on demand via `loadSkill`.
- **Slash commands** — builtins plus custom `.md` commands auto-loaded from project / user dirs.
- **MCP** — connect external [MCP](https://modelcontextprotocol.io) servers (stdio / http / sse) and bridge their tools to the model, gated by permissions.
- **Sessions & checkpointing** — resumable sessions (`--resume` / `--continue`) with append-only persistence; `/rewind` back to an earlier point.
- **Interactive TUI** — a full-screen REPL with live streaming output, mouse scroll & selection, a live status line, and next-input prediction.

## Product highlights

**The differences you feel as a user:**

- **DeepSeek tuning out of the box** — no `cache_control` to tweak, no wire format to guess, no error-code docs to dig through: install, drop in your key, and go. Thinking levels, cache hits, and error messages are all defaults tuned for DeepSeek.
- **`.md` custom sub-agents** — drop one Markdown file into `.nova/agents/` (or `.claude/agents/`), declare `name` / `description` / `tools` (allow-list) / `readOnly` / `model` / `maxTurns` / `maxTokens` in front matter, and the body becomes the role prompt — it instantly becomes a new sub-agent type, visible in `/agents`, callable via `/agent <name> <task>`, and spawnable by the model itself through `createSubAgent`.
- **Plan mode** — `/plan <goal>` delegates a **read-only** investigation and returns a step-by-step plan with key tradeoffs before touching anything.
- **A clean command UI** — commands that expand into a long prompt (`/agent`, `/plan`, `/init`) still show the **short input you actually typed** in history (display override), instead of flooding the transcript with the expanded text.
- **Sandbox on by default** — subprocess filesystem writes are confined to the workspace by an OS-level sandbox; unsupported platforms degrade automatically, so you get defense-in-depth with zero config.
- **Resumable & rewindable** — `--continue` picks up where you left off, `/rewind` drops history and file edits after a given message to return to an earlier point, and `/compact` collapses history into a single summary.
- **Readable errors** — tool-input validation failures are translated into plain language (e.g. `command is required (expected string)`) instead of a dumped blob of zod issues.

## Technical highlights

**The key engineering decisions:**

- **A loop with one extension point** — `@nova/core`'s agent loop has exactly one `HookRegistry` extension point: permissions, compaction, transcript writing, UI updates, and streaming are all hooks. **Blocking** hooks (`pre_*` / `post_tool_use`) can return a decision the loop must respect (first non-undefined wins); **advisory** hooks (`post_*`) are best-effort — errors swallowed, no state mutation. Every `tool_use` block is always paired with a `tool_result`, even on throw or denial.
- **Cache-friendliness baked into the design** — history is **append-only** with a byte-stable prefix, so DeepSeek's server-side context cache keeps hitting; `messages.jsonl` on disk is likewise append-only and only rewritten from a real divergence point. Micro-compaction is **off by default** (rewriting older tool_results invalidates the cache and the trimmed tokens would bill at the cheap cache-read rate anyway — net-negative on DeepSeek); auto-compaction fires only under window pressure, as a single deliberate prefix reset.
- **DeepSeek wire-format adaptation** — `detectThinkingFormat(model)` auto-selects the `deepseek` / `anthropic` wire format from the model id; the thinking budget maps to effort (`< 32k` → high, `>= 32k` → max); **thinking backfill** restores reasoning blocks DeepSeek streams but leaves empty in `finalMessage()`; 7 error codes (400/401/402/422/429/500/503) are translated into a `DeepSeekApiError` with remediation, and transient ones are retried internally.
- **In-process sub-agents, fresh context** — sub-agents run in-process, never see the parent conversation, get the parent's tool set minus `createSubAgent` itself (so they can't recurse), and report back a single final message — keeping large investigations out of the main context; multiple calls in one turn run concurrently.
- **OS-level sandbox, defense-in-depth** — built on [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) (macOS Seatbelt / Linux bubblewrap), confining `bash` and long-running-command **writes** to the workspace roots, layered on top of the permission engine rather than replacing it.
- **zod boundaries + a strict dependency direction** — tool inputs, settings, and everything crossing a package boundary carry a zod schema; `@nova/core` is model-agnostic and never imports a model SDK / tool implementation / UI; the monorepo dependency direction is one-way and not reversible (see [Repository layout](#repository-layout)).

---

## Quick start

Requires **Node ≥ 20** (see `.nvmrc`) and **pnpm 10.28.2**.

```bash
pnpm install
pnpm dev                                   # launch the REPL (tsx runs apps/cli/src/index.ts)
pnpm dev "add unit tests for this function" # one-shot prompt
```

First launch drops you into an interactive setup that writes `~/.nova/nova.config.json` (API key, model, session dir, …). You can also edit that file by hand.

### CLI flags

```bash
pnpm dev [prompt...]                # run an initial prompt, then stay in the REPL
  -p, --prompt <text>               # initial prompt (alternative to positional)
  -m, --model <name>                # override model for this run
  -t, --think off|low|medium|high|max   # extended-thinking level (or integer budget)
  --cwd <dir>                       # working directory for tools
  --resume <id>                     # resume a specific session
  -c, --continue                    # resume the most recent session
  --list-sessions                   # list saved sessions and exit
  --max-turns <n>                   # cap loop iterations
  --no-transcript                   # skip transcript writing
  --no-pretty                       # disable pretty logging
```

The `-t` levels map to fixed token budgets: `off` = 0, `low` = 2k, `medium` = 8k, `high` = 16k, `max` = 32k; you can also pass an integer budget to override the level.

### Slash commands (inside the REPL)

```
/help                this help
/think [<level>]     show or change extended-thinking level
/clear               clear conversation history (keeps session)
/compact [focus…]    summarize history into a single message
/resume [<id>]       switch to a saved session (no arg = pick from list)
/rewind [<n>]        rewind to an earlier message (history and file edits after it are discarded)
/init [focus…]       explore the codebase, then generate / refresh project memory (NOVA.md/CLAUDE.md/AGENTS.md)
/plan <goal>         delegate investigation to a read-only plan sub-agent, then present a plan
/agents [reload]     list available sub-agent types; `reload` rescans files
/agent <name> <task> delegate a task to a specific sub-agent
/predict [on|off]    show or toggle next-input prediction placeholder
/commands [reload]   list registered slash commands; `reload` rescans files
/skills              list discovered SKILL.md files
/mcp [tools]         show MCP server status; `tools` lists every bridged tool
/lsp                 show configured language servers (on PATH? started this session?)
/exit, /quit         leave the REPL
```

Builtins always win on name collisions; on top of them, any `*.md` file in
`.nova/commands` (project) or `~/.nova/commands` (user) — also `.claude/commands`
and `~/.claude/commands` — is auto-registered as a slash command. The front
matter declares the description, arg hint, and arg spec; the body is sent as the
next prompt with placeholders expanded.

Commands that expand into a long prompt (`/agent`, `/plan`, `/init`, …) still show
the **short input you actually typed** in message history rather than the expanded
text (display override, stored in `display-overrides.jsonl` under the session dir,
cleared on `/clear`).

`Ctrl+D` also exits; `Esc` interrupts the current turn.

### Skills

Drop a `SKILL.md` under `.nova/skills/<name>/` (project) or `~/.nova/skills/<name>/`
(user) — also `.claude/skills` / `~/.claude/skills`. Nova scans them on startup,
injects the name/description index into the system prompt, and exposes a
`loadSkill` tool the model can call to pull the full body on demand. `/skills`
shows what was found and where each one was loaded from.

### Sub-agents

The model can delegate work with the `createSubAgent` tool. A sub-agent runs
in-process with a **fresh context** (it never sees the parent conversation) and
the parent's tool set minus `createSubAgent` itself — so it can't recurse. Three
built-in types:

- `explore` — read-only retrieval (no write/edit/bash); locates code and reports paths/usages.
- `plan` — read-only planning; investigates a task and returns a step-by-step plan.
- `general-purpose` — full tool access for work that changes files or runs commands.

Multiple `createSubAgent` calls in one turn run concurrently (bounded by
`toolConcurrency`). The parent receives only each sub-agent's final message.
Configure via `settings.subagent` (`enabled`, `model`, `maxTurns`, `maxTokens`);
the `/plan` slash command is a thin wrapper that asks the agent to spawn a `plan`
sub-agent. Per-sub-agent transcripts land under
`~/.nova/sessions/{id}/subagents/`.

#### Custom sub-agent types

Beyond the three built-ins, you can **define as many as you want**. Drop a Markdown
file at `.nova/agents/<name>.md` (project) or `~/.nova/agents/<name>.md` (user) —
`.claude/agents/` is also accepted:

```markdown
---
name: reviewer
description: read-only code reviewer that reports findings with file:line
tools: [read, grep, glob, lsp]   # optional: tool allow-list (intersected with the available set)
readOnly: true                   # optional: withhold write/edit/bash
model: deepseek-chat             # optional: override the model
maxTurns: 20                     # optional: override the loop cap
maxTokens: 60000                 # optional: override the token cap
---

You are a read-only code-review sub-agent. Review the diff file by file and
report problems with file:line…
```

- Front matter requires `name` (`^[a-z][a-z0-9-]*$`) and `description` (≤200 chars);
  the rest is optional, and the body becomes the agent's role prompt (injected into
  its system prompt).
- **Precedence**: project dirs are scanned before user dirs, **first seen wins**
  (project shadows user); **built-ins always win**, so a same-named custom type is
  skipped and reported on `/agents reload`.
- `createSubAgent`'s `type` is validated against the dynamic registry; an unknown
  type returns an error listing the available ones.
- `/agents` lists everything (with `[builtin]`/`[project]`/`[user]` source tags and
  constraints), `/agents reload` rescans in place (no restart — effective on the
  next spawn), and `/agent <name> <task>` delegates directly.

### MCP (Model Context Protocol)

Nova can connect to external [MCP](https://modelcontextprotocol.io) servers at
startup and surface their tools to the model as `mcp__<server>__<tool>`, gated by
the normal permission engine (default-**ask**). A server's native JSON Schema is
sent to the model verbatim, so tools keep their exact contract. Two transports
are supported: a local subprocess over **stdio**, or a remote **http**/**sse**
endpoint.

Configure servers under `mcp.servers` in `~/.nova/nova.config.json`:

```jsonc
{
  "mcp": {
    "enabled": true,          // master switch (default true)
    "timeoutMs": 60000,       // per-tool-call timeout
    "servers": {
      "filesystem": {         // stdio (type defaults to "stdio")
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
        "env": { "FOO": "bar" }   // optional; merged over a safe default env
      },
      "remote": {             // http / sse
        "type": "http",
        "url": "https://example.com/mcp",
        "headers": { "authorization": "Bearer …" }
      },
      "scratch": { "command": "…", "enabled": false }   // skip one server
    }
  }
}
```

Connections are established in parallel; a server that fails to connect is logged
and skipped — it never blocks startup or affects the others. Use **`/mcp`** to
see each server's state and tool count, and **`/mcp tools`** to list every
bridged tool name.

### LSP code intelligence

The `lsp` tool lets the model talk straight to **language servers** (JSON-RPC
over stdio) for navigation that's far more precise than grep — it understands
scopes and types. One tool, six actions:

- `definition` — go to definition
- `references` — find all usages
- `hover` — type/docs at a position
- `diagnostics` — errors/warnings for a file
- `document_symbols` — outline of a single file
- `workspace_symbol` — find a symbol by name across the project

Positions are **1-based** (line, column) to the model and converted to LSP's
0-based internally. The tool is **read-only** and auto-allowed by the permission
engine.

**Nova does not install language servers** — they must already be on PATH. Four
are auto-detected out of the box (a missing binary degrades silently to a
"not installed" tool result for that language):

| languageId | command | extensions |
|------------|---------|------------|
| `typescript` | `typescript-language-server --stdio` | ts/tsx/mts/cts/js/jsx/mjs/cjs |
| `python` | `pyright-langserver --stdio` | py/pyi |
| `go` | `gopls` | go |
| `rust` | `rust-analyzer` | rs |

Servers start **lazily on the first `lsp` call**, so "installed but idle" is the
normal pre-use state. Use **`/lsp`** to see, per language, whether the binary is
on PATH (● running / ○ installed / ● not installed) and whether it has been
started this session.

Configure under `lsp` in `~/.nova/nova.config.json`:

```jsonc
{
  "lsp": {
    "enabled": true,              // master switch (default true)
    "initTimeoutMs": 15000,       // handshake (initialize) timeout per server
    "requestTimeoutMs": 15000,    // per-request timeout (definition/references/…)
    "diagnosticsTimeoutMs": 3000, // how long to wait for publishDiagnostics after opening a file
    "servers": [                  // override/extend the built-in table, keyed by languageId
      {
        "languageId": "typescript",
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "extensions": ["ts", "tsx"]
      }
    ]
  }
}
```

In `servers`, an entry whose languageId matches a built-in **replaces** it
entirely; unknown ones are **appended**.

### File reads & command timeouts

- **`read` is line-numbered + paginated** — output is `cat -n`-style line numbers
  (right-padded to 6, tab-separated). The `offset` (1-based start line, default 1)
  and `limit` (max lines) params paginate by line; a single response caps at ~200K
  chars, oversized single lines are returned whole (never split mid-line), and a
  truncation appends the exact continuation call (e.g. `read(path="…", offset=<next>)`).
- **`bash` has a 60s hard cap** — `timeout_ms` is optional and capped at 60000ms.
  Dev servers, watchers, long builds, and downloads that may exceed it should use
  `runLongRunningCommand` / `checkLongRunningCommand` instead.

### Command sandbox (optional, OS-level isolation)

Run the subprocess-spawning tools (`bash`, `runLongRunningCommand`) inside an
OS-level sandbox that confines filesystem **writes** to the workspace roots (the
same allowed roots the permission engine uses). Built on
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime):
macOS Seatbelt (`sandbox-exec`), Linux bubblewrap. It is **defense-in-depth**
layered on top of the permission engine, not a replacement.

On by default (opt-out). Reads stay open and the **network is unrestricted**
(filesystem only). Unsupported platforms / missing deps degrade to no
sandboxing, so default-on is safe; set `"enabled": false` to turn it off
entirely. In `~/.nova/nova.config.json`:

```jsonc
{
  "sandbox": {
    "enabled": true,            // master switch (default true; set false to disable)
    "monitorViolations": true,  // annotate blocked writes onto output (macOS: a `log` watcher)
    "filesystem": {
      // workspace roots (cwd + permissions.additionalDirectories) are always
      // writable. allowWrite defaults to a set of common caches (~/.npm
      // ~/.cache ~/Library/Caches ~/.cargo ~/.rustup ~/go ~/.local/share/pnpm
      // ~/Library/pnpm ~/.yarn) so npm/pnpm/cargo/go work out of the box;
      // setting it explicitly REPLACES that list.
      "allowWrite": ["~/.npm", "~/.cargo", "/some/extra/dir"],
      "denyWrite": [".env"],       // deny writes even within an allowed root
      "denyRead": ["~/.ssh"],      // reads are otherwise open
      "allowGitConfig": true       // allow writing .git/config (default true)
    }
  }
}
```

- **macOS / Linux only**; unsupported platforms or missing host deps (macOS needs
  `ripgrep`; Linux also `bubblewrap`/`socat`) **degrade silently** to no
  sandboxing and the agent keeps running.
- Common package-manager caches are allowed by default (above); if a command is
  blocked writing somewhere else outside the workspace, add that path to
  `filesystem.allowWrite`.
- **A set of dangerous paths is force-protected by the SDK even inside the
  workspace**: `.git/hooks`, `.git/config`, `.vscode/`, `.idea/`,
  `.claude/{commands,agents}`, and dotfiles like `.gitconfig`/`.zshrc`/`.mcp.json`.
  This is hardcoded SDK policy — only `.git/config` can be re-opened via
  `allowGitConfig` (default true); `.git/hooks` is always blocked. To write the
  other protected paths, disable the sandbox (`enabled: false`).

### Prompt caching (DeepSeek)

DeepSeek's Anthropic-compatible endpoint does automatic, server-side **context
caching**: any request whose prefix exactly matches an earlier one reads the
shared tokens straight from cache (billed at a fraction of the normal input
rate) instead of reprocessing them. There is no `cache_control` to set — the
only thing that matters is that the message prefix stays byte-stable from one
turn to the next. Nova is built around keeping it stable:

- **Append-only history.** Each turn appends new messages and never rewrites
  earlier ones, so the cached prefix survives. Persistence mirrors this —
  `messages.jsonl` is written append-only as long as the on-disk prefix is
  intact, and only rewritten from the first point that actually diverged.
- **Micro-compaction is OFF by default.** It would rewrite older `tool_result`s
  every turn, invalidating the cache from the rewrite point to the end — and the
  tokens it trims would otherwise bill at the cheap cache-read rate, so on
  DeepSeek the net is marginal-to-negative. Auto-compaction stays on: it only
  fires under context-window pressure, as a single deliberate prefix reset. Flip
  `compact.micro.enabled = true` only on a provider with no prefix caching.
- **Cache accounting.** Each response's `cache_read_input_tokens` /
  `cache_creation_input_tokens` are surfaced and rolled into the per-session
  usage totals, so you can see how much of each turn actually hit the cache.

## Repository layout

```
packages/
  core           agent loop · model client · HookRegistry · message/stop-reason types
  agent          createAgent: per-turn driver + persistence + transcript wiring
  runtime        settings (zod) · pino logger · session storage
  tools          ToolRegistry · dispatcher · built-ins
                   bash · read · write · edit · glob · grep · notebook-edit
                   webfetch · websearch · askUserQuestion · lsp
                   todo (todoCreate/Update/Get/Clear) · task (taskCreate/Update/Get/List/Clear)
                   runLongRunningCommand / checkLongRunningCommand · loadSkill
  subagent       createSubAgent tool · sub-agent definitions/registry/loader (built-in + .md custom)
  context        3-layer memory (NOVA.md > CLAUDE.md > AGENTS.md) · auto compact (micro off by default)
  safety         PermissionEngine · approval prompts (rules + cwd-scoped read)
  sandbox        OS-level command sandbox (@anthropic-ai/sandbox-runtime): bash/long-running write isolation
  lsp            LSP client/manager (JSON-RPC over stdio) · language-server resolution (lazy start)
  external       SlashRegistry · .md slash command loader · MCP client (stdio/http transports, tool bridge)
  observability  Transcript (JSONL)
  multi-agent, isolation, sdk
                 reserved package slots
apps/
  cli            the nova binary (Ink/React REPL, only active app)
  http, vscode   placeholders, not implemented
eval/            replay harness + golden cases (excluded from main build / eslint / tsconfig)
docs/            design notes (skills, ask-user)
```

The dependency direction is one-way and not reversible (by actual source imports): `runtime` / `core` / `observability` / `lsp` are the leaf layer (no `@nova/*` source imports); `safety` → `runtime`; `context` → `core` + `runtime`; `tools` → `core` + `runtime` + `lsp`; `sandbox` / `external` → `core` (type-only); `agent` → `core` + `runtime` + `context` + `observability`; `subagent` → `agent` + `context` + `core` + `observability` + `runtime`; `cli` sits on top and depends on all of the above.

Inside the workspace, `@nova/*` packages import each other directly from `./src/index.ts`; on publish, `publishConfig` switches that to `dist/`.

## Where things live on disk

| Item | Path |
|------|------|
| Global config | `~/.nova/nova.config.json` |
| Sessions | `~/.nova/sessions/{id}/` |
| Transcript (observer event stream) | `~/.nova/sessions/{id}/transcript.jsonl` |
| Replayable message history | `~/.nova/sessions/{id}/messages.jsonl` |
| Slash display-override map | `~/.nova/sessions/{id}/display-overrides.jsonl` |
| Sub-agent transcripts/messages | `~/.nova/sessions/{id}/subagents/` |
| Session log | `~/.nova/sessions/{id}/session.log` |
| Memory (project layer) | Walks up from cwd; at each directory picks the highest-priority of `NOVA.md` > `CLAUDE.md` > `AGENTS.md` (no merging within a directory) |
| Memory (user layer) | `~/.nova/NOVA.md` → `~/.claude/CLAUDE.md` → `~/.config/agents/AGENTS.md` (first existing wins) |
| Custom sub-agent definitions | `.nova/agents/*.md` (project) · `~/.nova/agents/*.md` (user); `.claude/agents/` also accepted |

## Development

```bash
pnpm build                 # build all packages and apps (tsup, recursive)
pnpm typecheck             # tsc --noEmit across the workspace
pnpm test                  # vitest run
pnpm test:watch
pnpm vitest run path/to/file.test.ts   # single file
pnpm vitest run -t "name"              # filter by test name
pnpm lint / pnpm lint:fix
pnpm format / pnpm format:check
```

Per-package scripts work via `pnpm --filter @nova/<name> <script>`. Tests are picked up from `packages/*/src/**/*.test.ts(x)` (co-located with source).

New collaborators should start here:

- `CLAUDE.md` — project guide written for AI assistants (architecture invariants, loop contract, ESM `.js`-extension convention, zod-at-boundaries rule)
- `agent-harness-loop-architecture.html` — architecture diagram and overview

## License

[MIT](LICENSE) © Nova contributors.
