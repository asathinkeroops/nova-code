# AGENTS.md

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
- Active packages, seven of them: `core` (the loop), `runtime` (config/session/logging + transcript + cost), `safety` (permission engine + OS write confinement), `tools`, `mcp` (Model Context Protocol client), `lsp` (language-server code intelligence), `agent` (assembly + memory/compaction + sub-agents). Keep it at seven — a 200-line concern belongs in the package that owns its topic, not in a package of its own.
- `apps/cli` — the only active app. `apps/http` and `apps/vscode` are placeholders.
- `eval/` — replay harness; **excluded from eslint/tsconfig**, don't expect it to build with the rest.

## Architecture invariants

`@nova/core` is the model-agnostic loop and never imports a model SDK, tool implementation, or UI — callers wire those in.

**Dependency direction** (do not reverse) — by actual source imports, which every `package.json` now matches exactly (keep it that way: a declared dep nothing imports is a bug):

```
runtime, core, lsp  ──► (no @nova/* source imports — leaf layer)
safety              ──► core + runtime   (core type-only: SandboxBridge)
tools               ──► core + runtime + lsp
mcp                 ──► core + runtime   (both type-only; the `SlashCommand` contract it
                        bridges prompts into lives in runtime/slash-types.ts — the registry
                        and the .md loader are CLI-side)
agent               ──► core + runtime
cli (apps/cli)      ──► every package above
```

**Loop contracts** (`packages/core/src/loop.ts`) — load-bearing, read before changing:

- The loop has a single extension point: a `HookRegistry` passed in via `opts.hooks`. Permission gating, compaction, transcript writing, UI updates — all attach as hooks. There is no separate `observer` / `compactor` / `permission` option. `@nova/agent`'s `createAgent` registers the defaults; callers add more via `agent.on(point, fn)`.
- **Blocking hooks** (`pre_*`, `post_tool_use`) can return a decision the loop must respect; first non-undefined wins. **Advisory hooks** (`post_*`, `post_messages`) are best-effort — registry swallows their errors and they cannot mutate state.
- Every `tool_use` block always produces a paired `tool_result`, even on throw or permission denial — the dispatcher (`packages/tools/src/dispatcher.ts`) always builds one (schema/parse errors included), and the loop (`packages/core/src/loop.ts`, "defense in depth" pass) backfills any slot still missing a result. The next API turn requires the pairing.
- The `pre_compact` hook must return `{ messages: next }` **iff** `next !== messages` — the loop uses reference equality on the returned array to decide whether to emit `post_compact`.
- **`post_commit` is the durability boundary — persist there, never from `post_messages`.** `post_messages` fires on every *intermediate* mutation (the assistant message being revealed one `tool_use` at a time, the `tool_result` batch filling in), so its array's last entry is still being rewritten; an append-only writer attached to it would invalidate its own on-disk prefix. `post_commit` fires once at the end of each loop iteration, when every message it produced is final. `@nova/agent` writes `messages.jsonl` there, which is why an interrupt or a crash costs at most the in-flight tool round-trip rather than the whole turn. A persister must use the **payload's** array, not `deps.getMessages()` — sub-agents wire that to a constant `[]`.
- **Every exit path persists, including the failed ones.** `agentLoop` throwing (abort, transport error) destroys its return value but not the history it built — `createAgent` mirrors that via `post_messages`/`post_commit` and writes it on the way out. Skipping the write on failure is what makes `transcript.jsonl` (written per-event, mid-turn) and `messages.jsonl` disagree about whether a turn happened. The rescued array is only used when its `tool_use` ↔ `tool_result` pairing is complete; otherwise the last `post_commit` state wins, because an unpaired `tool_use` on disk makes the session unresumable.
- **`max_tokens` is recoverable, not fatal.** `decide` (`packages/core/src/stop-reason.ts`) maps a `max_tokens` stop to `{ kind: "truncated" }`. When the truncation lands with no tool calls, the loop re-prompts the model to continue, bounded by `maxTokensContinuations` (config default 3; `0` = legacy hard-stop). The counter resets on any turn that makes progress; only when the budget is exhausted does it throw `LoopTerminatedError("max_tokens")`. Truncation *after* complete tool_use blocks falls through to the normal tool path (the model made progress).
- **`messages` is append-only and this MUST be strictly honored.** The history grows only through `appendMessage` (`packages/core/src/messages.ts`), which returns a new array with the next message pushed — never mutate, splice, reorder, or edit-in-place an existing entry. **Compaction is append-only too:** the `pre_compact` hook returns a fresh array that is the current history **plus** a new `<compacted>` boundary message (`buildCompactor`/`manualCompact` in `apps/cli/src/compactor.ts` → `autoCompact` in `@nova/agent`) — it does **not** replace/truncate history. The full history is therefore retained verbatim on disk and rendered in full by the TUI; only the *model* sees a shorter view (see the prefix-cache bullet). `persistMessages` (`packages/agent/src/persistence.ts`) relies on this: it append-fast-paths `messages.jsonl` while the on-disk prefix matches and only falls back to an atomic full rewrite on a genuine shrink/divergence — `/clear` (fresh session) and `/rewind` (truncate), **not** compaction. An **empty cursor also forces a rewrite**: it means "this writer hasn't written yet", which says nothing about what is on disk, and appending on that assumption concatenates onto a pre-existing file. Any in-place edit of an already-persisted message silently breaks the prefix check and corrupts the replayable transcript.
- **Prefix-caching contract — append-only is only half of it; the `system` prompt is the other half.** Nova is tuned for DeepSeek's automatic prefix cache (longest-common-prefix KV reuse); it sets no explicit `cache_control` breakpoint — `system: req.system` is passed verbatim as byte 0 of every request prefix (`packages/core/src/model.ts`), with the **model-facing view** of the `messages` array following it. That view is `sliceFromLastCompacted(messages)` — the slice from the last `<compacted>` boundary onward — applied at the wire by the `withCompactionSlice` model-client decorator (`apps/cli/src/context.ts`), **not** the full canonical array (which stays append-only, fully persisted, and fully rendered). Within one compaction epoch the slice is itself append-only (its tail grows, its head is fixed), so the cache still hits turn-to-turn; appending a new `<compacted>` boundary moves the slice head forward and resets the prefix **once** — identical cache behavior to the old replace-the-history compaction, just with the archive retained. A turn cache-hits all prior context **iff** both halves stay byte-identical to the previous request: the view only grows at the tail (above) **and** `system` stays frozen *within* a session. The system prompt embeds the memory bundle, so the memory bundle must not change mid-session. The agent reads it via `getMemory: () => ctx.memory` (a getter, like `getModel`/`getSettings`, NOT a captured value), but `ctx.memory` is reassigned in exactly ONE place — `reloadMemory()`, called only from `switchToSession` (`/clear`, `/resume`), where the prefix is rebuilt for the switched-in session anyway, so the on-disk re-read (picking up edits incl. the agent's own auto-memory writes) costs nothing cache-wise. Do NOT reassign `ctx.memory` (or otherwise recompute `system`) anywhere else, and do NOT "fix" the lack of *mid-session* hot-reload by doing so: any in-session change to `system` shifts byte 0 and collapses the common prefix to ~0, forcing a full re-prefill of system + the **entire** history on every subsequent turn. For freshness without touching the prefix, the agent `read`s auto-memory files on demand (appends to the tail); reloaded memory enters the injected block at the next session boundary.

**Settings** — every new configurable option must be added to the zod schema in `packages/runtime/src/config.ts` (with a default) before being read anywhere. Config file: `~/.nova/nova.config.json`. Sessions live at `~/.nova/sessions/{id}/` with `transcript.jsonl` (hook events) and `messages.jsonl` (replayable history). **`transcript.jsonl` must stay readable on its own** — it is what users attach to a bug report. Every message the model reads has to reach it: model/tool output rides `post_assistant`/`post_user_message`, and nova-authored injections (compaction summary, todo/task reminders, background + monitor notifications, plan-mode reminder, interrupt marker) are mirrored as `message_injected` by `recordInjections` in `@nova/agent`, keyed off `meta.synthetic`. A new injection point that skips `markSynthetic` (`packages/core/src/messages.ts`) is invisible there, and nothing else records it — `pre_compact`/`pre_continue`/`pre_request` fire none of the mirrored hooks. On startup, session dirs whose newest file mtime is older than `settings.sessionCleanup.maxAgeDays` (default 30) are pruned; the active session is always protected.

**Sandbox** — the subprocess tools (`bash`, both its blocking and its `run_in_background` branch, plus `monitor`'s watch script) execute inside an OS-level sandbox: `@nova/safety`'s `createSandbox` produces a `SandboxBridge` (the type lives in `@nova/core`) backed by macOS Seatbelt / Linux bubblewrap that confines filesystem *writes* to the workspace roots plus `settings.sandbox.filesystem.allowWrite` (seeded from `DEFAULT_SANDBOX_ALLOW_WRITE`). Default-OFF (opt-in); enable via `settings.sandbox.enabled: true`, and even then it degrades to a no-op where unsupported.

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
- **Leave the suite green.** After a change, run the affected tests (the full suite for cross-cutting changes) and treat green as a precondition for "done," not optional. Any test that fails *because of your change* is yours to fix — fix the code, or update the test if the change legitimately made it stale. Never hand off a red suite; if a failure is genuinely pre-existing and out of scope, say so explicitly and ask — do **not** bury it under a "pre-existing" label as a reason to skip it.
- **Keep the user-facing docs in sync with the code.** When a change alters observable behavior — CLI flags/commands, settings keys and defaults, tool names or inputs, install/usage steps — update `README.md`, `README.en-US.md`, `docs/guide.md`, and `docs/guide.html` in the same change, keeping the Chinese and English copies (and the `.md`/`.html` pair) saying the same thing. Purely internal refactors that change nothing a user can observe need no doc edit; say so rather than silently skipping.
- This AGENTS.md is loaded by Nova's own memory system if `nova` runs on this repo, and ships in every agent request. Keep it to **durable invariants and conventions every task needs** — load-bearing contracts, dependency rules, things that bite if violated. Do **not** log feature additions, command catalogs, or changelog-style notes here (the CLI's `--help`, slash-command list, and git history already cover those); if a fact isn't needed on a typical request, leave it out.

## Git workflow

- **Every commit must include the co-author trailer** from `.gitmessage` (blank line before it, at the end of the message body): Add it explicitly in the commit command — don't rely on `commit.template` being wired up.
