# CLAUDE.md

## What this is

A terminal coding agent, deeply tuned for DeepSeek. — a TypeScript/Node LLM agent runtime (model loop, tools, permissions, context management, observability) packaged as a pnpm monorepo. The CLI binary is `nova`.

## Commands

```bash
pnpm dev                              # run the CLI via tsx
pnpm vitest run path/to/file.test.ts  # single test file
pnpm vitest run -t "name of test"     # by test name
pnpm --filter @nova/<pkg> <script>    # per-package script
```

Standard `pnpm install / build / typecheck / test / lint / format` also work. Node 20 (`.nvmrc`); package manager pinned to `pnpm@10.28.2`.

## Workspace layout

- `packages/*` (`@nova/<name>`) — library code. Workspace consumers import from `./src/index.ts` directly (no rebuild needed); published builds switch to `dist/` via `publishConfig`.
- `apps/cli` — the only active app. `apps/http` and `apps/vscode` are placeholders.
- `eval/` — replay harness; **excluded from eslint/tsconfig**, don't expect it to build with the rest.

## Architecture invariants

`@nova/core` is the model-agnostic loop and never imports a model SDK, tool implementation, or UI — callers wire those in.

**Dependency direction** (do not reverse):

```
core, runtime ──► (no @nova/* deps)
context, observability, safety, tools ──► core + runtime
agent ──► core + runtime + context + observability
cli ──► everything
```

**Loop contracts** (`packages/core/src/loop.ts`) — load-bearing, read before changing:

- The loop has a single extension point: a `HookRegistry` passed in via `opts.hooks`. Permission gating, compaction, transcript writing, UI updates — all attach as hooks. There is no separate `observer` / `compactor` / `permission` option. `@nova/agent`'s `createAgent` registers the defaults; callers add more via `agent.on(point, fn)`.
- **Blocking hooks** (`pre_*`, `post_tool_use`) can return a decision the loop must respect; first non-undefined wins. **Advisory hooks** (`post_*`, `post_messages`) are best-effort — registry swallows their errors and they cannot mutate state.
- Every `tool_use` block always produces a paired `tool_result`, even on throw or permission denial — `packages/tools/src/invariants.ts` enforces this at dispatch time. The next API turn requires the pairing.
- The `pre_compact` hook must return `{ messages: next }` **iff** `next !== messages` — the loop uses reference equality on the returned array to decide whether to emit `post_compact`.

**Settings** — every new configurable option must be added to the zod schema in `packages/runtime/src/config.ts` (with a default) before being read anywhere. Config file: `~/.nova/nova.config.json`. Sessions live at `~/.nova/sessions/{id}/` with `transcript.jsonl` (hook events) and `messages.jsonl` (replayable history).

**Memory** — global → user → project bundle, with per-directory priority `NOVA.md` > `CLAUDE.md` > `AGENTS.md` (highest priority wins; files are **not** merged). Filenames are configurable via `settings.memory.filenames`.

**Tool dispatch** — `ToolRegistry` definitions carry a zod input schema; `createDispatcher` validates inputs before calling `run`, and schema/parse errors become `is_error: true` tool_results rather than throws.

## Conventions

- **ESM with `.js` import extensions.** Intra-package imports use `.js` even when importing from `.ts` source (`import { x } from "./foo.js";`). TS is configured with `moduleResolution: "Bundler"` and `verbatimModuleSyntax: false`.
- **TS strict, `noUncheckedIndexedAccess` on.** Array/object access returns `T | undefined`; handle the `undefined` case — don't disable it locally.
- **Public APIs get a zod schema** — tool inputs, settings, anything crossing a package boundary that originates outside the type system.
- **Tests live next to source** as `*.test.ts(x)` under `packages/*/src/` and `apps/cli/src/`. The vitest glob does not pick up other `apps/`, `eval/`, or `examples/`.
- This CLAUDE.md is loaded by Nova's own memory system if `nova` runs on this repo.
