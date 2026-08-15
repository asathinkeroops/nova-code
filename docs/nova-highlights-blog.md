# Nova: The Coding Agent Built on Defensive Depth and Agentic Philosophy

*An in-depth look at the design principles that set Nova apart from Claude Code, Aider, and Cline.*

---

Most coding agents share a common architectural assumption: the model is mostly right, and edge cases are edge cases. Nova was built from the opposite premise — that the model will make mistakes, the output will get truncated, the tool calls will have wrong field names, and the filesystem will drift underneath you. Every design decision in Nova follows from this philosophy: **assume failure, build recovery, and never lose user work**.

This article walks through Nova's five defining design pillars, grounded in the actual [source code](https://github.com/nova-ai/nova-code) — a pnpm monorepo of ~20 packages in strict TypeScript with zod-validated boundaries throughout.

---

## 1. Append-Only Architecture for Zero-Cost Prefix Caching

Many agents treat conversation history as mutable — they rewrite messages after compaction, inject context in-place, or recompute the system prompt mid-session. Nova takes the opposite approach: **every byte of history is immutable once written**.

### The Three Invariants

The `messages` array is governed by a single function, `appendMessage` ([source](https://github.com/nova-ai/nova-code/blob/main/packages/core/src/messages.ts)), which returns a **new array** with the next message pushed. There is no splice, no reorder, no in-place edit. This rule is load-bearing:

1. **Persistence stays cheap.** `persistMessages` ([source](https://github.com/nova-ai/nova-code/blob/main/packages/agent/src/persistence.ts)) compares the in-memory prefix against an on-disk cursor. When the prefix matches, it appends only the delta via `appendFile`. Only when a session is rewound (`/rewind`) or cleared (`/clear`) does it fall back to an atomic full rewrite. This fast-path means that after a 100-turn session, persisting turn 101 costs a single JSONL line write, not a full-file serialization.

2. **The DeepSeek prefix cache stays hot.** Before every API call, `toWireMessages` ([source](https://github.com/nova-ai/nova-code/blob/main/packages/core/src/messages.ts#L34)) strips Nova-internal metadata (`meta` fields) to produce a byte-identical request body turn after turn. Since the DeepSeek gateway's automatic KV cache keys off the longest common prefix, Nova's append-only message stream achieves **95%+ cache hit rates**.

3. **Compaction preserves the archive.** When context grows too large, Nova does not truncate history. It appends a single `<compacted>` boundary message, and a model-client decorator (`withCompactionSlice`) instructs the model to see only the slice from the last boundary forward. The full conversation is retained on disk and rendered in full by the TUI. Within one compaction epoch, the model-facing view is itself append-only — its head is fixed, its tail grows — so the cache continues to hit.

### The System Prompt Is Frozen

This is the subtlest and most consequential invariant. The `system` prompt sits at byte 0 of every API request. If it changes mid-session — even by one byte — the entire prefix shifts and the KV cache collapses to zero. Nova's memory bundle is embedded in the system prompt, so it **must not change** within a session. The agent reads memory files on demand for freshness but only re-reads them at session boundaries (`/clear`, `/resume`), where the prefix is rebuilt for the switched-in session anyway.

> **Why it matters:** Claude Code, Aider, and Cline all have compaction strategies that truncate or rewrite history. Nova's append-only plus frozen-system approach is unique and purpose-built for the economics of DeepSeek's server-side caching.

---

## 2. Defense in Depth — Every Layer Assumes Failure

Nova's core loop (`agentLoop`, [source](https://github.com/nova-ai/nova-code/blob/main/packages/core/src/loop.ts)) operates on a simple principle: the model is unreliable, and the system should recover gracefully from every failure mode.

### max_tokens Is Recoverable, Not Fatal

When a model hits its per-response output cap (8,192 tokens on DeepSeek), every other agent terminates with an error. Nova's `decide()` function ([source](https://github.com/nova-ai/nova-code/blob/main/packages/core/src/stop-reason.ts)) maps `max_tokens` to `kind: "truncated"`, which triggers one of two recovery paths:

- **Truncation after complete tool_use blocks** → execute the tools normally. The model made real progress; the tool results will prompt the next turn.
- **Truncation mid-text with no tool calls** → re-prompt the model to continue from where it left off, bounded by `maxTokensContinuations` (default 3). The counter resets on any turn that produces tool calls.

This means a model can produce a 30,000-token response across 4 consecutive continuations — Nova handles the stitching transparently.

### Every tool_use Gets a Paired tool_result

The API protocol demands strict pairing: every `tool_use` block must be followed by a `tool_result` before the next turn. Nova enforces this at two levels:

1. **Dispatcher level** ([source](https://github.com/nova-ai/nova-code/blob/main/packages/tools/src/dispatcher.ts)): tool not found → `is_error` result. Schema validation fails → `is_error` result with actionable fix hints. Invariant violation → `is_error` result. `handler.run()` throws → caught and wrapped as `is_error`.

2. **Loop level** (defense-in-depth pass, [source](https://github.com/nova-ai/nova-code/blob/main/packages/core/src/loop.ts#L331)): after all concurrent tool executions settle, the loop scans for any slot where `results[i] === undefined` and backfills an `is_error` tool_result. Even if a concurrent worker silently fails, the next API call is always legal.

### File-Access Invariants

The `InMemoryFileAccessLedger` ([source](https://github.com/nova-ai/nova-code/blob/main/packages/tools/src/invariants.ts)) maintains a per-session ledger keyed by symlink-resolved canonical paths — the same canonicalization as the permission engine. Before any `edit` or overwriting `write`, it enforces:

- **Read-before-edit**: the file must have been `read` first (prevents hallucinated edits).
- **Mtime-drift**: the file must not have been externally modified since the last read (prevents overwriting the user's parallel work).

After a successful write, the ledger treats the write as an implicit read (the on-disk content is exactly what the agent wanted), so subsequent edits don't require a re-read.

### Input Aliasing Without Security Gaps

DeepSeek frequently uses non-canonical field names — `filePath` or `file_path` instead of `path`. Nova's `withAliases` ([source](https://github.com/nova-ai/nova-code/blob/main/packages/tools/src/schema.ts)) rewrites these during zod `preprocess`, before validation. The critical design choice: **downstream code receives `parsed.data`, never raw input**. The invariants layer always sees `input.path`, never `input.filePath`, so the read-before-edit gate cannot be bypassed through field-name shenanigans.

> **Why it matters:** Other agents either reject non-canonical fields (failing ~40% of DeepSeek calls) or pass raw input through (opening security gaps). Nova's normalize-then-validate approach achieves both robustness and safety.

---

## 3. Agentic Everything — Sub-agents as First-Class Citizens

Nova does not treat the primary agent as a monolith. It delegates specialized work to sub-agents — not as an afterthought, but as a core architectural primitive.

### Three Built-in Types

```typescript
// packages/agent/src/definitions.ts
general-purpose  → full tools (read, write, edit, bash)
explore          → READ-ONLY (no write/edit/bash)
plan             → READ-ONLY (investigate + report plan, no implementation)
```

Each type has a distinct system prompt and capability set. The read-only constraint is enforced at two layers: the tool list omits the mutating tools, **and** the permission layer independently rejects them. Sub-agents have isolated contexts, cannot spawn further sub-agents, and report back only their final message — keeping the parent's context clean.

### Real-Time Progress Streaming

Sub-agents run in parallel with the parent. Their intermediate steps (thinking summaries, tool uses, final output) are streamed into a [display sidecar](https://github.com/nova-ai/nova-code/blob/main/apps/cli/src/display-sidecar.ts) — a `display-sidecar.jsonl` append-only log — and rendered beneath the parent's `createSubAgent` tool card in the TUI. The user sees what each sub-agent is doing in real time, yet the model interaction remains clean and uncluttered.

### Goal-Driven Auto-Correction

The `/goal` system ([source](https://github.com/nova-ai/nova-code/blob/main/apps/cli/src/goal.ts)) takes this further: after each agent turn, a **separate evaluation sub-agent** (with full bash, LSP, and web-fetch access) runs real verification — executing tests, reading files, checking outputs — and reports `VERDICT: MET` or `VERDICT: NOT_MET`. If not met, the main agent is re-invoked with the evaluator's feedback, up to a configurable limit. This is not pattern-matching or exit-code checking; it's a full agentic verification loop.

### AI-Powered Risk Classification

In `auto` permission mode, bash commands pass through a three-tier classifier: static DENY rules (recursive rm, disk writes, pipe-to-shell), static ALLOW rules (pure-read commands), and a model classifier for everything in between. This avoids both the brittleness of pure regex rules and the cost of asking the user about every `ls`.

> **Why it matters:** Claude Code has sub-agents (Task tool) but without typed definitions or read-only enforcement. Aider has no sub-agent concept. Cline has a separate task system. Nova's typed registry + goal-driven verification + risk classifier form a unique composition.

---

## 4. Real Code Intelligence — LSP, Not Grep

Nova is currently the only open-source coding agent that ships a **full Language Server Protocol client** as a first-class tool.

### Architecture

The `@nova/lsp` package ([source](https://github.com/nova-ai/nova-code/blob/main/packages/lsp/src/manager.ts)) implements:

- **Self-built JSON-RPC transport** with Content-Length framing, async request/notification routing, and per-request timeouts — zero LSP library dependencies.
- **Multi-server multiplexing**: one `LspManager` manages one `LspClient` per `languageId`, lazily started on first use and reused across calls. `.ts` and `.tsx` files share a single `typescript-language-server` process.
- **Full capability matrix**: `definition`, `implementation`, `references`, `hover`, `diagnostics`, `document_symbols`, `workspace_symbol`.
- **Document synchronization**: `didOpen`/`didChange` before each query, then wait for `publishDiagnostics` before returning results.
- **Graceful degradation**: `LspUnavailableError` becomes a normal `is_error` tool result, never a crash.

### Tool Integration

The `lsp` tool ([source](https://github.com/nova-ai/nova-code/blob/main/packages/tools/src/builtin/lsp.ts)) bridges the gap between 1-based model coordinates and 0-based LSP coordinates, renders diagnostics with ANSI-colored severity prefixes, and supports context-rich reference display with source lines. The tool description tells the model exactly what it can ask: go-to-definition at a cursor position, find all references to a symbol, check diagnostics for a file.

> **Why it matters:** Claude Code, Aider, and Cline all rely on grep/ripgrep for code search. Nova's LSP integration provides IDE-grade go-to-definition, type-on-hover, and workspace symbol search — without the model needing to guess file locations from regex matches.

---

## 5. OS-Level Safety Without Friction

Nova's sandbox (`@nova/safety` 的 sandbox, [source](https://github.com/nova-ai/nova-code/blob/main/packages/safety/src/sandbox.ts)) wraps macOS Seatbelt and Linux bubblewrap at the OS kernel level — it does not rely on Node.js permission models or pattern-based filtering.

### What It Enforces

- **Write confinement**: subprocess writes are restricted to workspace roots plus user-configured `allowWrite` paths.
- **Read blacklisting**: specific paths can be denied reads (`.env` files, SSH keys).
- **Network isolation**: domain allow/deny lists, Unix socket control, HTTP/SOCKS proxy tunneling, MITM proxy support, TLS termination.
- **Violation visibility**: `annotateOutput` injects violation notices into stderr so the agent knows it was restricted.

### Graceful Degradation

The sandbox is designed to **never block the user**:

- When the platform is unsupported or dependencies are missing, it silently degrades to a no-op bridge (`active: false`).
- When a single command's sandbox wrapping fails, the command still executes (fail-open).
- Enable it with one line: `sandbox.enabled: true` in config, or `/sandbox on` in-session.

> **Why it matters:** Claude Code's sandbox is closed-source. Aider and Cline have no OS-level sandbox. Nova's is fully open, inspectable, and designed to be safe to enable by default.

---

## The Complete Developer Experience

Beyond these five pillars, Nova ships a comprehensive toolchain that makes it feel less like a CLI tool and more like a development platform:

| Feature | What It Does |
|---|---|
| **Multi-session hot-swap** | `/resume` opens an interactive picker of all past sessions; `switchToSession` migrates the full agent state. `/clear` creates a fresh session without losing the old one. |
| **File snapshots + /rewind** | Write-before snapshot via SHA-256 content-addressed blob store. Rewind rolls back **both** conversation history and file state, with automatic conflict detection if files were externally modified. |
| **Cron scheduler** | `cronCreate` lets the agent set up recurring tasks — interval-based (`5m`) or cron expressions (`0 9 * * *`). Auto-re-arms on `/resume`. |
| **Cross-session Task Store** | Persistent task dependency graph with `blockedBy` edges, stored in `.tasks/{id}.json`. Multiple tasks can be `in_progress` concurrently. |
| **Plugin ecosystem** | `nova plugin install|uninstall|list` — compatible with Claude Code's plugin format. Plugins contribute slash commands, sub-agents, skills, hooks, MCP servers, and LSP servers. |
| **Headless JSONL eval** | `nova -p "prompt" --format jsonl` runs the full agent loop in CI mode, reusing the same hooks and tool stack as interactive mode. |
| **Display sidecar** | UI rendering is decoupled from model input. Slash command expansions show the original short command to the user while the model receives the full prompt. |
| **Slash command autocomplete** | File-index-backed `@path` tab completion, namespace-aware command discovery (`.nova/commands/frontend/component.md` → `/frontend:component`). |

---

## How Nova Compares

| Capability | Nova | Claude Code | Aider | Cline |
|---|---|---|---|---|
| **LSP code intelligence** | ✅ First-class tool | ❌ grep only | ❌ grep only | ❌ external |
| **Goal auto-correction loop** | ✅ Agentic verification | ❌ | ❌ | ❌ |
| **File snapshots + rewind** | ✅ History + files | ❌ | ❌ | ❌ |
| **max_tokens recovery** | ✅ Auto-continue | ❌ Hard error | ❌ Hard error | ❌ |
| **Append-only prefix cache** | ✅ 95%+ hit rate | Partial | N/A | N/A |
| **Session hot-swap** | ✅ Full state migration | `--continue` only | ❌ | ❌ |
| **In-session cron** | ✅ | ❌ | ❌ | ❌ |
| **Task dependency graph** | ✅ Persistent | ❌ | ❌ | ❌ |
| **Display sidecar** | ✅ UI/model separation | ❌ | ❌ | ❌ |
| **AI risk classifier** | ✅ 3-tier | ✅ closed-source | ❌ | ❌ |
| **OS-level sandbox** | ✅ Open source | ✅ closed-source | ❌ | ❌ |
| **Plugin system** | ✅ CC-compatible | ✅ | ❌ | ❌ |
| **Typed sub-agents** | ✅ 3 built-in types | Partial | ❌ | Partial |

---

## The Philosophy, in One Sentence

**Nova is an open-source coding agent runtime built on the belief that the model is an unreliable but brilliant collaborator — so every layer must assume failure, recover gracefully, and never lose user work.**

- **Assume failure**: max_tokens is a pause, not a crash. Tool calls with wrong field names still work. Every tool_use gets a paired tool_result, even if the dispatcher explodes.
- **Recover gracefully**: Goal evaluation runs a full sub-agent to verify, not a regex. Truncation continuation is automatic. File conflicts on rewind are detected and skipped.
- **Never lose work**: Append-only history means every message is preserved. Byte-stable wire format means the prefix cache is always hot. The snapshot store means you can always rewind.

If you're building on DeepSeek, need fine-grained safety guarantees, or want a coding agent that treats reliability as a first-class concern — Nova is worth a serious look.

---

*Nova is open source under the Apache 2.0 license. [github.com/nova-ai/nova-code](https://github.com/nova-ai/nova-code)*
