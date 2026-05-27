# Nova

![Nova screenshot](snapshots/screen.png)

> A terminal coding agent, deeply tuned for DeepSeek.

Nova is a coding agent that lives in your terminal — reads code, runs commands, edits files, and drives a task to done through tool use. It speaks the Anthropic message shape internally, but the model layer is built around **DeepSeek**: thinking is wired to DeepSeek's `output_config.effort` (not Anthropic's `budget_tokens`), the wire format is auto-detected from the model id, and the default prompts/permissions are tuned for DeepSeek's behavior. Other Anthropic-compatible endpoints still work — DeepSeek is the path that gets first-class care.

Under the hood Nova is a loop-centric harness: `@nova/core` exposes a model-agnostic agent loop and a single `HookRegistry` extension point; tools, permissions, context, observability, skills, and slash commands all attach through it. `@nova/agent` packages the loop into a per-turn `createAgent` with persistence and transcript wiring, and `apps/cli` is what you actually run — the `nova` binary, an Ink/React REPL.

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
pnpm dev [prompt...]                # send one turn directly
  --model <name>                    # override model for this run
  --think off|low|medium|high|max   # extended-thinking budget
  --resume <session-id>             # resume a specific session
  --continue                        # resume the most recent session
  --list-sessions                   # list saved sessions
  --max-turns <n>                   # cap loop iterations
  --no-transcript                   # skip transcript writing
  --no-pretty                       # disable pino-pretty
```

### Slash commands (inside the REPL)

```
/help                this help
/model [<name>]      show or change the active model
/think [<level>]     show or change extended-thinking level
/clear               clear conversation history (keeps session)
/compact [focus…]    summarize history into a single message
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
  context        3-layer memory (NOVA.md > CLAUDE.md > AGENTS.md) · micro/auto compact
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
