# Nova

![Nova screenshot](snapshots/screen.png)

> A terminal coding agent, deeply tuned for DeepSeek.

Nova is a coding agent that lives in your terminal — reads code, runs commands, edits files, and drives a task to done through tool use. It speaks the Anthropic message shape internally, but the model layer is built around **DeepSeek**: thinking is wired to DeepSeek's `output_config.effort` (not Anthropic's `budget_tokens`), the wire format is auto-detected from the model id, and the default prompts/permissions are tuned for DeepSeek's behavior. Other Anthropic-compatible endpoints still work — DeepSeek is the path that gets first-class care.

Under the hood Nova is a loop-centric harness: `@nova/core` exposes a model-agnostic agent loop, and tools, permissions, context management, observability, and orchestration plug in through its hooks and observer. `apps/cli` wires the pieces into the working REPL (the `harness` binary).

Status: **M1 shipped** (base loop + bash/read/write + permissions + transcript). **M2 in progress** — three-layer memory loading and micro/auto compaction are done; prompt cache, hooks, and cost/metrics are next. Full roadmap in `docs/M1-TODO.md` through `docs/M4-TODO.md`.

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
/help              this help
/model [<name>]    show or change the active model
/think [<level>]   show or change extended-thinking level
/clear             clear conversation history (keeps session)
/compact [focus…]  summarize history into a single message
/resume [<id>]     switch to a saved session (no arg = pick from list)
/exit, /quit       leave the REPL
```

`Ctrl+D` also exits; `Esc` interrupts the current turn.

## Repository layout

```
packages/
  core           agent loop · model client · message/stop-reason types
  runtime        config (zod) · pino logger · session storage
  tools          ToolRegistry · dispatcher · built-ins (bash/read/write/edit/glob/grep/webfetch/websearch/ask-user/todo)
  safety         PermissionEngine · approval UI (Ink/React) · hooks (M2 W7)
  context        3-layer memory (NOVA.md > CLAUDE.md > AGENTS.md) · micro/auto compact · cache (M2 W5)
  orchestration  TodoStore · todo tools · background tasks
  observability  Transcript (JSONL) · cost/metrics (M2 W8)
  external       MCP / Skills / slash command loader (M2 W8 + M3 W9)
  multi-agent    subagent isolation + summary handoff (M3 W10)
  isolation, sdk reserved (M3/M4)
apps/
  cli            the harness binary (only active app)
  http, vscode   placeholders, not implemented
eval/            replay harness + golden cases (excluded from main build / eslint / tsconfig)
docs/            per-milestone TODO (M1–M4) and design notes
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
- `docs/M{current}-TODO.md` — what's actually in scope right now; don't pull later-milestone work in
- `agent-harness-loop-architecture.html` — architecture diagram and overview

## License

Unspecified. Private project.
