# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nova is a loop-centric agent harness — a TypeScript/Node implementation of an LLM agent runtime (model loop, tools, permissions, context management, observability) packaged as a pnpm monorepo. The current CLI binary is `harness`. Roadmap milestones are in `docs/M1-TODO.md` … `docs/M4-TODO.md`; M1 is the shipped base, M2 is in progress.

## Common commands

```bash
pnpm install                 # bootstrap workspace
pnpm dev                     # run the CLI locally via tsx (apps/cli/src/index.ts)
pnpm build                   # build all packages and apps (tsup, recursive)
pnpm typecheck               # tsc --noEmit across the workspace

pnpm test                    # vitest run (all packages)
pnpm test:watch              # vitest watch
pnpm vitest run path/to/file.test.ts        # single file
pnpm vitest run -t "name of test"           # by test name

pnpm lint                    # eslint .
pnpm lint:fix
pnpm format                  # prettier --write .
pnpm format:check
```

Per-package scripts (`build`, `dev`, `typecheck`) are also available via `pnpm --filter @nova/<pkg> <script>`. Node 20 is required (`.nvmrc`); package manager is pinned to `pnpm@10.28.2`.

## Workspace layout

- `packages/*` — library code (`@nova/<name>`). Each package exports `./src/index.ts` directly for in-workspace consumers and switches to `dist/` via `publishConfig` when published, so changes are picked up without a rebuild.
- `apps/*` — entry points. `apps/cli` is the only active app; `apps/http` and `apps/vscode` are placeholders.
- `eval/` — replay harness and golden cases (excluded from eslint/tsconfig — don't rely on it building with the rest).
- `docs/M{1..4}-TODO.md` — authoritative scope per milestone. Read the relevant Mn-TODO before adding a new feature so you don't accidentally pull M3/M4 work into M2.

## Architecture: how the pieces fit

The codebase is structured so that **`@nova/core` is the model-agnostic loop and everything else plugs in through it**. The loop never imports a model SDK, a tool implementation, or a UI — callers (i.e. the CLI) wire those in.

### Dependency direction (enforced informally; CI rule planned)

```
core ──────────────────────────────────────────────► (no deps on other @nova/*)
runtime ───────────────────────────────────────────► (no deps on other @nova/*)
context, observability, orchestration, safety, tools ──► core + runtime
cli ────────────────────────────────────────────────► everything
```

Do not introduce reverse imports (e.g. `core` depending on `tools`). `safety` and `observability` interact with the loop only via the observer/hook callbacks the loop exposes.

### The agent loop (`packages/core/src/loop.ts`)

`agentLoop()` is a single while-loop that:

1. Calls `compactor?(messages)` (optional pre-call hook — used for micro/auto compact).
2. Calls `model.call({ system, messages, tools, ... })`.
3. Appends the assistant message, applies `decide(stopReason)` to choose return/continue/error.
4. For each `tool_use` block: runs `checkPermission?` → `executeTool` → emits a `tool_result` block. **Every `tool_use` always produces a paired `tool_result`**, even if a tool throws or permission is denied, because the API requires the pairing on the next turn. Don't break this invariant.
5. Calls `interject?({ turn, toolUses })` (optional post-turn hook for injecting reminders, e.g. todo nags).
6. Loops until `end_turn`, max turns, or an error stop reason.

All side-channels (logging, transcript, cost, UI rendering) go through the single `observer` callback — they don't get to mutate messages.

### Tools (`packages/tools`)

- `ToolRegistry` holds tool definitions (zod-validated input schema + `run`).
- `createDispatcher({ registry })` returns a `ToolExecutor` that the loop calls; it validates input against the schema before invoking `run`. Schema/parse errors become `is_error: true` tool_results rather than throws.
- Built-ins live in `packages/tools/src/builtin/` (bash, read, write, edit, glob, grep, webfetch, websearch, ask-user, todo/*). `builtinTools(todoStore)` returns the full set.
- M2 (in progress) is adding `tools/invariants.ts` for read-before-edit / mtime / path-allowlist checks; expect a dispatcher chain `dispatch → safety → invariants → tool` once landed.

### Runtime, sessions, and settings (`packages/runtime`)

- Settings schema is a single zod object in `config.ts`; **every new configurable option must be added there**, including a default, before reading it elsewhere.
- Config file: `~/.nova/nova.config.json` (override via `loadSettings(path)`).
- Sessions: `createSession()` creates `~/.nova/sessions/{id}/` with `transcript.jsonl` (observer events) and `messages.jsonl` (replayable message history). `listSessions` / `getSession` enable resume/continue from the CLI.
- Logging is pino (`createLogger`); the CLI flips to pretty mode by default.

### Permissions and safety (`packages/safety`)

- `PermissionEngine` evaluates `settings.permissions.rules` (per-tool `allow`/`deny`/`ask` plus optional `match` against the input). The `ask` callback is wired in the CLI to an Ink/React TTY approval prompt (`approval.tsx`).
- `isDangerousBash` (in runtime) hard-blocks a small set of obviously destructive commands.
- M2 will add the `hooks.ts` dispatcher for `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop`; today the file exists but is not yet integrated.

### Context (`packages/context`)

- `memory.ts` loads a 3-layer memory bundle (global → user → project), with per-directory priority `NOVA.md` > `CLAUDE.md` > `AGENTS.md`. Only the highest-priority file in a given directory is loaded (not merged). Project search walks up to the repo root (`.git`).
- `compact.ts` is the two-layer compactor: `microCompact` (replaces old `tool_result` content with placeholders, preserves "read"-style tools by default) + `autoCompact` (token-threshold-triggered LLM summarization, drops a transcript snapshot and replaces the history with one user message). The CLI wires them through `agentLoop`'s `compactor` hook.
- `cache.ts` is the planned prompt-cache breakpoint injector (M2 W5, not yet implemented).

### Observability (`packages/observability`)

- `Transcript` writes the JSONL stream of loop observer events to `session.dir/transcript.jsonl`.
- `cost.ts` and `metrics.ts` are M2 W8 deliverables (token cost accounting, budget alerts, basic metrics).

### CLI (`apps/cli/src/`)

The CLI is a REPL that wires all the packages together. Key files:

- `index.ts` — entry: parses flags, loads settings + memory, builds the model/registry/dispatcher/permission/transcript/compactor, calls `agentLoop`, prints assistant output, persists messages.
- `compactor.ts` — wraps `microCompact`/`autoCompact` into the `compactor` hook the loop expects.
- `persistence.ts` — appends new messages to `session.dir/messages.jsonl` between turns (cursor-based) so `--resume <id>` and `--continue` work.
- `renderers.ts`, `markdown.ts`, `screen.ts`, `colors.ts` — terminal rendering.
- `setup.ts` — first-run interactive settings wizard.

## Conventions

- **ESM everywhere.** All packages set `"type": "module"`; intra-package imports use the `.js` extension even when importing from `.ts` source (`import { x } from "./foo.js";`). TypeScript is configured for `moduleResolution: "Bundler"` and `verbatimModuleSyntax: false` so this resolves correctly.
- **TypeScript strict is non-negotiable.** `noUncheckedIndexedAccess` is on — array/object access returns `T | undefined`. Don't disable it locally; handle the `undefined` case.
- **Public APIs get a zod schema.** Tool inputs, settings, anything crossing a package boundary that originates from outside the type system.
- **Tests live next to source** as `*.test.ts(x)` under `packages/*/src/`. Vitest picks them up via the glob in `vitest.config.ts`; it does not run anything under `apps/`, `eval/`, or `examples/`.
- **Don't bypass the loop's contracts.** The `tool_use ↔ tool_result` pairing, the `compactor` returning a new array iff it actually changed something (the loop uses reference equality to decide whether to emit a `compact` event), and the observer being best-effort (errors swallowed) are all load-bearing — read `loop.ts` before changing them.
- **Memory file priority is `NOVA.md > CLAUDE.md > AGENTS.md`** and configurable via `settings.memory.filenames`. This file (CLAUDE.md) will be loaded by Nova's own memory system if run on this repo.
