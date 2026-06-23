<p align="center">
  <img src="docs/logo.en.svg" alt="NOVA-CODE" width="600">
</p>

[简体中文](README.md) · **English**

![Nova screenshot](snapshots/screen.png)

> The coding agent purpose-built for DeepSeek — 95%+ cache hits · OS-sandboxed · tool-complete · install-and-go. 

Nova reads code, runs commands, edits files — and drives your task to done through tool use. It's built around **DeepSeek**: thinking maps to effort (not `budget_tokens`), the wire format is auto-detected from the model id, and the entire request pipeline is tuned so DeepSeek's automatic context cache keeps hitting. Other Anthropic-compatible endpoints work too; DeepSeek gets first-class care.

## Why Nova

**DeepSeek-native, zero config.**
No `cache_control` to tweak, no wire format to guess, no error-code docs to dig through. Install, drop in your key, go. Thinking levels, cache hits, and error messages are all tuned for DeepSeek out of the box.

**Cache-friendly by design.**
History is append-only, keeping the byte-stable prefix DeepSeek's server-side cache depends on — faster responses, fewer tokens billed. Micro-compaction is off by default (it breaks the cache prefix); auto-compaction only fires under real window pressure.

**Sandbox-on, defense in depth.**
Subprocess writes are confined to the workspace by an OS-level sandbox (macOS Seatbelt / Linux bubblewrap), layered on top of the permission engine. Unsupported platforms degrade silently — you get protection with zero config.

**Extend with markdown.**
Define custom sub-agents, slash commands, skills, or lifecycle hooks — drop a `.md` file with frontmatter and you're done. No code changes, ships with the repo.

**Bring your habits, not a manual.**
Nova closely mirrors the Claude Code workflow — the same slash commands, keybindings, approval prompts, memory files, and replayable sessions. If you've used Claude Code there's nothing new to learn: install and keep working the way you already do, just on an engine tuned for DeepSeek underneath.

## Quick start

Requires **Node ≥ 20** and **pnpm 10.28.2**.

```bash
pnpm install
pnpm dev                           # launch the REPL
pnpm dev -p "explain this code"    # headless: one turn, print & exit
```

First launch walks through an interactive setup (API key, model, etc.) → `~/.nova/nova.config.json`.

## Features

### Built-in tools

Tools the model can call — covering read/write, search, execution, code intelligence, and the web:

| Tool | Capability |
| --- | --- |
| `read` / `write` / `edit` | Read files (line-numbered + paginated, incl. `.xlsx` / `.ods` spreadsheets and images), whole-file write, exact-text replace |
| `glob` / `grep` | Filename matching, full-text regex search |
| `bash` | Run shell commands |
| `runInBackground` / `getBackgroundOutput` / `killBackground` | Run long tasks (dev servers, watchers) in the background |
| `lsp` | Code intelligence: go-to-definition, references, hover, diagnostics, symbol search |
| `webfetch` / `websearch` | Fetch web pages, search the web |
| `createTodo` / `updateTodo` / `getTodoList` / `clearTodoList` | In-session multi-step checklist |
| `createTask` / `updateTask` / `getTaskList` / `clearTaskList` | Cross-session task plan with dependencies |
| `askUserQuestion` | Ask the user multiple-choice questions and wait for answers |
| `loadSkill` | Load a skill on demand |

### Built-in commands

| Command | Capability |
| --- | --- |
| `/help` | See all commands |
| `/model` · `/effort` | Switch models, adjust the thinking level |
| `/compact` | Summarize long history |
| `/clear` · `/resume` · `/rewind` | Start a fresh session, resume a past one, roll back history |
| `/rename` | Give the current session a custom name (shown on the input frame) |
| `/plan` | Investigate read-only and produce an implementation plan |
| `/goal` | Set a success condition and auto-work toward it until met |
| `/diff` · `/review` | Browse and review uncommitted changes |
| `/init` | Analyze the codebase to generate `NOVA.md` |
| `/agents` · `/agent` | See sub-agent types, delegate a task |
| `/commands` · `/skills` · `/mcp` · `/lsp` | See registered commands, skills, MCP servers, language servers |
| `/usage` · `/context` | See token usage, cache hits, context fill |
| `/tasks` | View and manage background commands (`runInBackground`) — list / stop |
| `/predict` | Toggle next-input prediction |
| `/exit` · `/quit` | Quit |

### Core capabilities

| Capability | What it gives you |
| --- | --- |
| Sub-agents | Work with fresh context and their own tool set: `explore` (read-only retrieval), `plan` (read-only planning), `general-purpose` (full access), plus custom types |
| Permissions & sandbox | `shift+tab` cycles `default` / `acceptEdits` / `plan`; an OS-level sandbox confines subprocess writes to the workspace (macOS Seatbelt / Linux bubblewrap), default-on |
| File guarding | Files must be read before they're edited, and external changes are detected — no accidental clobbering |
| MCP | Connect external MCP servers (`stdio` / `http` / `sse`) and use their tools like built-ins, under the same permission gating |
| Skills | Write reusable playbooks as `SKILL.md`, loaded on demand by the model — token-cheap and distributable with the repo |
| Markdown extensions | Custom slash commands, sub-agents, and lifecycle hooks: drop a `.md` into `.nova/`, configure via frontmatter, no code changes |
| Three-layer memory | Global → user → project, loaded by `NOVA.md` > `CLAUDE.md` > `AGENTS.md` priority |
| TUI | Full-screen Ink/React REPL, streaming output + mouse; `@path` / `/` completion, `↑` `↓` history; live status line with token usage, cache hits, cost, DeepSeek balance, git branch, context fill |

## Architecture

At Nova's core is a single model loop (`agentLoop`) with **one extension point** — a typed `HookRegistry`. Permission gating, compaction, transcript writing, and UI updates all attach as hooks at named lifecycle points; `@nova/core` itself imports no model SDK, tool implementation, or UI. Blocking hooks (◆) can rewrite or veto a step; advisory hooks (○) only observe.

![Nova agent loop & hook mechanism](docs/agent-loop.svg)

## Repository layout

```
packages/
  core           agent loop · model client · HookRegistry · message/stop-reason types
  agent          createAgent: per-turn driver + persistence + transcript wiring
  runtime        settings (zod) · pino logger · session storage
  tools          ToolRegistry · dispatcher · built-in tools
  subagent       createSubAgent tool · sub-agent definitions/registry/loader
  context        3-layer memory (NOVA.md > CLAUDE.md > AGENTS.md) · auto compact
  safety         PermissionEngine · approval prompts
  sandbox        OS-level command sandbox (write isolation)
  lsp            LSP client/manager (JSON-RPC over stdio)
  external       SlashRegistry · .md command loader · MCP client
  observability  Transcript (JSONL)
apps/
  cli            the `nova` binary (Ink/React REPL, only active app)
  http, vscode   placeholders, not yet implemented
eval/            replay harness + golden cases (excluded from main build)
docs/            design notes & user manual
```

Dependency direction: `runtime` / `core` / `observability` / `lsp` are leaves (no `@nova/*` source imports); `safety` → `runtime`; `context` → `core` + `runtime`; `tools` → `core` + `runtime` + `lsp`; `sandbox` / `external` → `core` (type-only); `agent` → `core` + `runtime` + `context` + `observability`; `subagent` → `agent` + `context` + `core` + `observability` + `runtime`; `cli` depends on all of the above.

## Development

```bash
pnpm build                 # build all packages and apps (tsup, recursive)
pnpm typecheck             # tsc --noEmit across the workspace
pnpm test                  # vitest run
pnpm test:watch
pnpm vitest run path/to/file.test.ts
pnpm vitest run -t "name"
pnpm lint / pnpm lint:fix
pnpm format / pnpm format:check
```

Per-package scripts: `pnpm --filter @nova/<name> <script>`. Tests live next to source: `packages/*/src/**/*.test.ts(x)`.

New contributors should start with:
- `CLAUDE.md` — architecture invariants, loop contract, ESM conventions
- `nova-architecture.html` — architecture diagram and overview

## License

[MIT](LICENSE) © Nova contributors.
