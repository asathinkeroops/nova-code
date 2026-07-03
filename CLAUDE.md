# CLAUDE.md

## What this is

A terminal coding agent, deeply tuned for DeepSeek — a TypeScript/Node LLM agent runtime (model loop, tools, permissions, context management, observability) packaged as a pnpm monorepo. The CLI binary is `nova`.

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
- Active packages: `core`, `runtime`, `observability`, `safety`, `context`, `tools`, `external` (MCP), `sandbox` (OS-level write confinement), `lsp` (language-server code intelligence), `agent`, `subagent`. `sandbox` and `lsp` are the most recently added.
- `apps/cli` — the only active app. `apps/http` and `apps/vscode` are placeholders.
- `eval/` — replay harness; **excluded from eslint/tsconfig**, don't expect it to build with the rest.

## Architecture invariants

`@nova/core` is the model-agnostic loop and never imports a model SDK, tool implementation, or UI — callers wire those in.

**Dependency direction** (do not reverse) — by actual source imports; some `package.json`s declare a superset (e.g. `core` and `observability` list `@nova/runtime`, and `lsp` lists `@nova/core`, but never import them):

```
runtime, core, observability, lsp  ──► (no @nova/* source imports — leaf layer)
safety                             ──► runtime
context                            ──► core + runtime
tools                              ──► core + runtime + lsp
sandbox, external                  ──► core            (both import core type-only)
agent                              ──► core + runtime + context + observability
subagent                           ──► agent + context + core + observability + runtime
cli (apps/cli)                     ──► every package above
```

**Loop contracts** (`packages/core/src/loop.ts`) — load-bearing, read before changing:

- The loop has a single extension point: a `HookRegistry` passed in via `opts.hooks`. Permission gating, compaction, transcript writing, UI updates — all attach as hooks. There is no separate `observer` / `compactor` / `permission` option. `@nova/agent`'s `createAgent` registers the defaults; callers add more via `agent.on(point, fn)`.
- **Blocking hooks** (`pre_*`, `post_tool_use`) can return a decision the loop must respect; first non-undefined wins. **Advisory hooks** (`post_*`, `post_messages`) are best-effort — registry swallows their errors and they cannot mutate state.
- Every `tool_use` block always produces a paired `tool_result`, even on throw or permission denial — the dispatcher (`packages/tools/src/dispatcher.ts`) always builds one (schema/parse errors included), and the loop (`packages/core/src/loop.ts`, "defense in depth" pass) backfills any slot still missing a result. The next API turn requires the pairing.
- The `pre_compact` hook must return `{ messages: next }` **iff** `next !== messages` — the loop uses reference equality on the returned array to decide whether to emit `post_compact`.
- **`max_tokens` is recoverable, not fatal.** `decide` (`packages/core/src/stop-reason.ts`) maps a `max_tokens` stop to `{ kind: "truncated" }`. When the truncation lands with no tool calls, the loop re-prompts the model to continue, bounded by `maxTokensContinuations` (config default 3; `0` = legacy hard-stop). The counter resets on any turn that makes progress; only when the budget is exhausted does it throw `LoopTerminatedError("max_tokens")`. Truncation *after* complete tool_use blocks falls through to the normal tool path (the model made progress).
- **`messages` is append-only and this MUST be strictly honored.** The history grows only through `appendMessage` (`packages/core/src/messages.ts`), which returns a new array with the next message pushed — never mutate, splice, reorder, or edit-in-place an existing entry. **Compaction is append-only too:** the `pre_compact` hook returns a fresh array that is the current history **plus** a new `<compacted>` boundary message (`buildCompactor`/`manualCompact` in `apps/cli/src/compactor.ts` → `autoCompact` in `@nova/context`) — it does **not** replace/truncate history. The full history is therefore retained verbatim on disk and rendered in full by the TUI; only the *model* sees a shorter view (see the prefix-cache bullet). `persistMessages` (`packages/agent/src/persistence.ts`) relies on this: it append-fast-paths `messages.jsonl` while the on-disk prefix matches and only falls back to an atomic full rewrite on a genuine shrink/divergence — `/clear` (fresh session) and `/rewind` (truncate), **not** compaction. Any in-place edit of an already-persisted message silently breaks the prefix check and corrupts the replayable transcript.
- **Prefix-caching contract — append-only is only half of it; the `system` prompt is the other half.** Nova is tuned for DeepSeek's automatic prefix cache (longest-common-prefix KV reuse); it sets no explicit `cache_control` breakpoint — `system: req.system` is passed verbatim as byte 0 of every request prefix (`packages/core/src/model.ts`), with the **model-facing view** of the `messages` array following it. That view is `sliceFromLastCompacted(messages)` — the slice from the last `<compacted>` boundary onward — applied at the wire by the `withCompactionSlice` model-client decorator (`apps/cli/src/context.ts`), **not** the full canonical array (which stays append-only, fully persisted, and fully rendered). Within one compaction epoch the slice is itself append-only (its tail grows, its head is fixed), so the cache still hits turn-to-turn; appending a new `<compacted>` boundary moves the slice head forward and resets the prefix **once** — identical cache behavior to the old replace-the-history compaction, just with the archive retained. A turn cache-hits all prior context **iff** both halves stay byte-identical to the previous request: the view only grows at the tail (above) **and** `system` stays frozen *within* a session. The system prompt embeds the memory bundle, so the memory bundle must not change mid-session. The agent reads it via `getMemory: () => ctx.memory` (a getter, like `getModel`/`getSettings`, NOT a captured value), but `ctx.memory` is reassigned in exactly ONE place — `reloadMemory()`, called only from `switchToSession` (`/clear`, `/resume`), where the prefix is rebuilt for the switched-in session anyway, so the on-disk re-read (picking up edits incl. the agent's own auto-memory writes) costs nothing cache-wise. Do NOT reassign `ctx.memory` (or otherwise recompute `system`) anywhere else, and do NOT "fix" the lack of *mid-session* hot-reload by doing so: any in-session change to `system` shifts byte 0 and collapses the common prefix to ~0, forcing a full re-prefill of system + the **entire** history on every subsequent turn. For freshness without touching the prefix, the agent `read`s auto-memory files on demand (appends to the tail); reloaded memory enters the injected block at the next session boundary.

**Settings** — every new configurable option must be added to the zod schema in `packages/runtime/src/config.ts` (with a default) before being read anywhere. Config file: `~/.nova/nova.config.json`. Sessions live at `~/.nova/sessions/{id}/` with `transcript.jsonl` (hook events) and `messages.jsonl` (replayable history). On startup, session dirs whose newest file mtime is older than `settings.sessionCleanup.maxAgeDays` (default 30) are pruned; the active session is always protected.

**Sandbox** — subprocess tools (`bash`, the long-running `run`) execute inside an OS-level sandbox: `@nova/sandbox`'s `createSandbox` produces a `SandboxBridge` (the type lives in `@nova/core`) backed by macOS Seatbelt / Linux bubblewrap that confines filesystem *writes* to the workspace roots plus `settings.sandbox.filesystem.allowWrite` (seeded from `DEFAULT_SANDBOX_ALLOW_WRITE`). Default-OFF (opt-in); enable via `settings.sandbox.enabled: true`, and even then it degrades to a no-op where unsupported.

**Code intelligence** — `@nova/lsp` (`LspManager`) spawns/multiplexes language servers; the `lsp` tool and `/lsp` command expose hover, diagnostics, document/workspace symbols, and definitions. It is the one runtime dependency `@nova/tools` takes beyond `core`/`runtime`. Configured under `settings.lsp`.

**Memory** — global → user → project bundle, with per-directory priority `NOVA.md` > `CLAUDE.md` > `AGENTS.md` (highest priority wins; files are **not** merged). Filenames are configurable via `settings.memory.filenames`.

**Tool dispatch** — `ToolRegistry` definitions carry a zod input schema; `createDispatcher` validates inputs before calling `run`, and schema/parse errors become `is_error: true` tool_results rather than throws. The dispatcher then threads the **validated, normalized** input (not raw `use.input`) into the invariants gate and `run`. This matters because schemas can rewrite keys pre-validation: `withAliases` (`packages/tools/src/schema.ts`) accepts `filePath`/`file_path`/`file` as aliases for `path` (a frequent DeepSeek slip) via `z.preprocess`, so `read`/`edit`/`write` tolerate them while the advertised wire schema still shows only canonical names. Handing the raw input to the invariants layer would skip read-before-edit gating whenever the model used an alias.

**File-access invariants** — `packages/tools/src/invariants.ts` holds a per-session `InMemoryFileAccessLedger` (threaded through `ToolContext`) enforcing **read-before-edit** and **mtime-drift** checks. Reads/writes are recorded under symlink-resolved canonical paths (`canonicalizePath`, same as the permission gate) so an edit through an alias still matches its prior read; a stale or absent read surfaces as an `is_error` tool_result instead of clobbering the file.

## Conventions

- **Source is the only ground truth.** Answer every question from the *current* code — read the actual source before claiming what exists or how it works. Local docs (`docs/`, `README*`, design notes) and even this file may be stale or aspirational; never treat them as authoritative without confirming against source. When a doc and the code disagree, the code wins and the doc is the bug.
- **ESM with `.js` import extensions.** Intra-package imports use `.js` even when importing from `.ts` source (`import { x } from "./foo.js";`). TS is configured with `moduleResolution: "Bundler"` and `verbatimModuleSyntax: false`.
- **TS strict, `noUncheckedIndexedAccess` on.** Array/object access returns `T | undefined`; handle the `undefined` case — don't disable it locally.
- **Public APIs get a zod schema** — tool inputs, settings, anything crossing a package boundary that originates outside the type system.
- **Tests live next to source** as `*.test.ts(x)` under `packages/*/src/` and `apps/cli/src/`. The vitest glob does not pick up other `apps/`, `eval/`, or `examples/`.
- This CLAUDE.md is loaded by Nova's own memory system if `nova` runs on this repo, and ships in every agent request. Keep it to **durable invariants and conventions every task needs** — load-bearing contracts, dependency rules, things that bite if violated. Do **not** log feature additions, command catalogs, or changelog-style notes here (the CLI's `--help`, slash-command list, and git history already cover those); if a fact isn't needed on a typical request, leave it out.

## Git workflow

- **Every commit must include the co-author trailer** from `.gitmessage` (blank line before it, at the end of the message body):

  ```
  Co-authored-by: Claude <81847+claude@users.noreply.github.com>
  ```

  Add it explicitly in the commit command — don't rely on `commit.template` being wired up.
