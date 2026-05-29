# Nova

![Nova screenshot](snapshots/screen.png)

> A terminal coding agent, deeply tuned for DeepSeek.

Nova is a coding agent that lives in your terminal — reads code, runs commands, edits files, and drives a task to done through tool use. It speaks the Anthropic message shape internally, but the model layer is built around **DeepSeek**: thinking is wired to DeepSeek's `output_config.effort` (not Anthropic's `budget_tokens`), the wire format is auto-detected from the model id, and the default prompts/permissions are tuned for DeepSeek's behavior. Other Anthropic-compatible endpoints still work — DeepSeek is the path that gets first-class care.

Under the hood Nova is a loop-centric harness: `@nova/core` exposes a model-agnostic agent loop and a single `HookRegistry` extension point; tools, permissions, context, observability, skills, and slash commands all attach through it. `@nova/agent` packages the loop into a per-turn `createAgent` with persistence and transcript wiring, and `apps/cli` is what you actually run — the `nova` binary, a full-screen Ink/React REPL with mouse scroll/selection and a live status line.

The loop runs tool calls with **bounded concurrency** (default 3 per turn), and the model can spawn **sub-agents** via the `createSubAgent` tool — fresh-context workers (`explore` / `plan` / `general-purpose`) that run in-process and report a single final message back, so large investigations stay out of the main context.

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

### Slash commands (inside the REPL)

```
/help                this help
/model [<name>]      show or change the active model
/think [<level>]     show or change extended-thinking level
/clear               clear conversation history (keeps session)
/compact [focus…]    summarize history into a single message
/plan <goal>         delegate investigation to a read-only plan sub-agent, then present a plan
/resume [<id>]       switch to a saved session (no arg = pick from list)
/predict [on|off]    show or toggle next-input prediction placeholder
/commands [reload]   list registered slash commands; `reload` rescans files
/skills              list discovered SKILL.md files
/exit, /quit         leave the REPL
```

Builtins always win on name collisions; on top of them, any `*.md` file in
`.nova/commands` (project) or `~/.nova/commands` (user) — also `.claude/commands`
and `~/.claude/commands` — is auto-registered as a slash command. The front
matter declares the description, arg hint, and arg spec; the body is sent as the
next prompt with placeholders expanded.

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
types:

- `explore` — read-only retrieval (no write/edit/bash); locates code and reports paths/usages.
- `plan` — read-only planning; investigates a task and returns a step-by-step plan.
- `general-purpose` — full tool access for work that changes files or runs commands.

Multiple `createSubAgent` calls in one turn run concurrently (bounded by
`toolConcurrency`). The parent receives only each sub-agent's final message.
Configure via `settings.subagent` (`enabled`, `model`, `maxTurns`, `maxTokens`);
the `/plan` slash command is a thin wrapper that asks the agent to spawn a `plan`
sub-agent. Per-sub-agent transcripts land under
`~/.nova/sessions/{id}/subagents/`.

## Repository layout

```
packages/
  core           agent loop · model client · HookRegistry · message/stop-reason types
  agent          createAgent: per-turn driver + persistence + transcript wiring
  runtime        settings (zod) · pino logger · session storage
  tools          ToolRegistry · dispatcher · built-ins
                   bash · read · write · edit · glob · grep · notebook-edit
                   webfetch · websearch · askUserQuestion
                   todo (todoCreate/Update/Get/Clear) · task (taskCreate/Update/Get/List/Clear)
                   runLongRunningCommand / checkLongRunningCommand · loadSkill
  subagent       createSubAgent tool · sub-agent system prompt (explore/plan/general-purpose)
  context        3-layer memory (NOVA.md > CLAUDE.md > AGENTS.md) · auto compact (micro off by default)
  safety         PermissionEngine · approval prompts (rules + cwd-scoped read)
  external       SlashRegistry · .md slash command loader (MCP/transport stubs reserved)
  observability  Transcript (JSONL)
  multi-agent, isolation, sdk
                 reserved package slots
apps/
  cli            the nova binary (Ink/React REPL, only active app)
  http, vscode   placeholders, not implemented
eval/            replay harness + golden cases (excluded from main build / eslint / tsconfig)
docs/            design notes (skills, ask-user)
```

Inside the workspace, `@nova/*` packages import each other directly from `./src/index.ts`; on publish, `publishConfig` switches that to `dist/`.

## Where things live on disk

| Item | Path |
|------|------|
| Global config | `~/.nova/nova.config.json` |
| Sessions | `~/.nova/sessions/{id}/` |
| Transcript (observer event stream) | `~/.nova/sessions/{id}/transcript.jsonl` |
| Replayable message history | `~/.nova/sessions/{id}/messages.jsonl` |
| Sub-agent transcripts/messages | `~/.nova/sessions/{id}/subagents/` |
| Session log | `~/.nova/sessions/{id}/session.log` |
| Memory (project layer) | Walks up from cwd; at each directory picks the highest-priority of `NOVA.md` > `CLAUDE.md` > `AGENTS.md` (no merging within a directory) |
| Memory (user layer) | `~/.nova/NOVA.md` → `~/.claude/CLAUDE.md` → `~/.config/agents/AGENTS.md` (first existing wins) |

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
