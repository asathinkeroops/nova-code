/**
 * The ports an agent runs on.
 *
 * A **port** is a mechanism the loop orchestrates and there is exactly ONE
 * implementation of per agent: the model transport, the system prompt, the tool
 * host, history, compaction, the permission gate. core owns the interface, the
 * call site, and the invariant assertion around it; the implementation lives in
 * whatever package owns that topic (`@nova/agent`, `@nova/safety`, the CLI).
 *
 * A **hook** (see `hooks.ts`) is the other half: 0..N subscribers that observe
 * or lightly amend, owning no mechanism. Ports do not replace hooks — a port is
 * simply the built-in node that always sits FIRST in its hook chain, which is
 * exactly how `createAgent` wires the built-in permission / compaction closures
 * today. Making it a port only gives it a name, a type, and a place to assert.
 *
 * ── THE LIVENESS RULE ──────────────────────────────────────────────────────
 *
 * The port container is constructed ONCE per agent. Everything that can change
 * mid-session therefore has to live BEHIND A METHOD, never in a field the agent
 * reads once:
 *
 *   model            `/model`                  → pass a forwarding client
 *   thinking / effort `/think`, `/effort`      → `OptionsProvider.turn()`
 *   tool set          MCP connect, plan mode   → `ToolHost.list()`
 *   settings          `/config`                → `OptionsProvider.turn()`
 *   session id        `/resume`, `/clear`      → `SystemPromptProvider.epoch()`
 *
 * The one deliberate exception is the system prompt, which must NOT change
 * within an epoch — see {@link SystemPromptProvider} and
 * {@link freezeSystemPrompt}.
 *
 * Violating this rule fails silently rather than loudly: nothing crashes, but a
 * `/model` switch stops taking effect, or the prefix cache collapses while every
 * feature still works.
 */

import type {
  MessageParam,
  PermissionResult,
  ToolContext,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// System prompt
// ────────────────────────────────────────────────────────────────────────────

/**
 * Produces the `system` string — for the main agent that is the memory bundle,
 * the skills block, the behavioural rules and the date/session tags; for a
 * sub-agent it is a fixed task-role prompt.
 *
 * Not a plain string, for three reasons:
 *
 * 1. `epoch()` is the anchor for the prefix-cache freeze. Nova is tuned for
 *    DeepSeek's automatic prefix cache and `system` is byte 0 of every request,
 *    so any mid-session change collapses the common prefix to ~0 and re-prefills
 *    the ENTIRE history on every subsequent turn. A string has nowhere to hang
 *    "this must not change" on; an epoch does (see {@link freezeSystemPrompt}).
 * 2. It has to bind late — memory reloads at a session boundary, and the skills
 *    block only exists after skills finish loading.
 * 3. Main agent and sub-agent build it differently; two implementations beat one
 *    `if` plus an optional override field.
 */
export interface SystemPromptProvider {
  /**
   * Identity of the current prefix epoch — in practice the session id. The
   * system prompt is allowed to change ONLY when this changes, which happens at
   * `/clear` and `/resume`, where the prefix is rebuilt for the switched-in
   * session anyway.
   */
  epoch(): string;
  /** The system prompt for the current epoch. Must be pure and cheap. */
  system(): string | Promise<string>;
}

/** A `SystemPromptProvider` over a fixed string (sub-agents, tests, tooling). */
export function staticPrompt(system: string, epoch = "static"): SystemPromptProvider {
  return { epoch: () => epoch, system: () => system };
}

export interface SystemPromptDrift {
  epoch: string;
  /** The value frozen for this epoch — what the agent keeps using. */
  frozen: string;
  /** The value the provider just returned, which is being discarded. */
  observed: string;
}

/**
 * Raised by {@link freezeSystemPrompt} in `strict` mode when a provider changes
 * its system prompt without advancing its epoch.
 */
export class SystemPromptDriftError extends Error {
  constructor(public readonly drift: SystemPromptDrift) {
    super(
      `system prompt changed within epoch "${drift.epoch}" — this collapses the prefix cache. ` +
        `Advance epoch() (a session boundary) instead of mutating the prompt mid-session.`,
    );
    this.name = "SystemPromptDriftError";
  }
}

export interface FreezeOptions {
  /** Throw {@link SystemPromptDriftError} on drift instead of keeping the frozen value. */
  strict?: boolean;
  /** Called on drift in non-strict mode (log it; the frozen value is kept). */
  onDrift?: (drift: SystemPromptDrift) => void;
}

/**
 * Wrap a provider so its output is frozen for the lifetime of an epoch: the
 * first value seen in an epoch is the value every later turn gets, and a new
 * epoch re-reads.
 *
 * Drift is *detected*, not merely prevented: the inner provider is still called
 * every turn and its output compared, so a mid-session prompt change surfaces as
 * a warning (or a throw under `strict`) rather than as an unexplained tenfold
 * jump in prompt cost. That is why providers must stay cheap and pure — the
 * check runs once per turn.
 *
 * Non-strict is the default on purpose: a prefix-cache regression is a cost bug,
 * not a correctness bug, and killing the user's turn over it would be worse than
 * the bug. Tests should pass `strict: true`.
 */
export function freezeSystemPrompt(
  inner: SystemPromptProvider,
  opts: FreezeOptions = {},
): SystemPromptProvider {
  let frozen: { epoch: string; system: string } | undefined;

  return {
    epoch: () => inner.epoch(),
    async system(): Promise<string> {
      const epoch = inner.epoch();
      const observed = await inner.system();
      if (frozen && frozen.epoch === epoch) {
        if (observed !== frozen.system) {
          const drift: SystemPromptDrift = { epoch, frozen: frozen.system, observed };
          if (opts.strict) throw new SystemPromptDriftError(drift);
          opts.onDrift?.(drift);
        }
        return frozen.system;
      }
      frozen = { epoch, system: observed };
      return observed;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Compaction
// ────────────────────────────────────────────────────────────────────────────

export interface CompactRequest {
  /**
   * `"auto"` lets the implementation apply its own threshold and decline (see
   * the no-op convention on {@link Compactor.compact}); `"manual"` is the
   * `/compact` command and always summarizes.
   */
  reason: "auto" | "manual";
  /** Free-form focus hint from `/compact <focus>`. */
  focus?: string;
  /**
   * Tokens the next request spends on everything that is not conversation — the
   * system prompt and the tool schemas, re-sent verbatim every call. Counted
   * against the threshold because it occupies the window just as the messages
   * do; omitting it makes an auto trigger fire only once the real request is
   * already over the window.
   */
  overheadTokens?: number;
}

/**
 * Owns the two halves of "the history the model sees is not the history we
 * keep": the boundary-appending summarizer, and the slice that boundary implies.
 */
export interface Compactor {
  /**
   * The model-facing view of an append-only history — everything from the last
   * compaction boundary onward. Called on the way to the wire on EVERY request,
   * so it must be synchronous and allocation-cheap. Its result is never written
   * back to the canonical history.
   */
  view(messages: MessageParam[]): MessageParam[];
  /**
   * Compact, or decline. Returning the SAME array reference means "nothing to do"
   * and lets the `pre_compact` hook chain have its turn; returning a new array
   * short-circuits it.
   *
   * The result MUST be an append-only extension of the input — the full history
   * plus a new boundary message — never a truncation or a rewrite. The loop
   * enforces this with {@link assertAppendOnly}; see that function for why.
   */
  compact(messages: MessageParam[], req: CompactRequest): Promise<MessageParam[]>;
}

// ────────────────────────────────────────────────────────────────────────────
// Permission
// ────────────────────────────────────────────────────────────────────────────

/**
 * The built-in first node of the `pre_tool_use` chain. A denial short-circuits
 * the chain (the loop turns it into an `is_error` tool_result); a grant lets the
 * registered hooks run and deny in their own right.
 *
 * Takes the whole `tool_use` block rather than `(name, input)` so a gate can
 * correlate with the `pre_permission` / `post_permission` events by `use.id`.
 */
export interface PermissionGate {
  check(use: ToolUseBlock, ctx: ToolContext): Promise<PermissionResult>;
}

// ────────────────────────────────────────────────────────────────────────────
// History
// ────────────────────────────────────────────────────────────────────────────

/**
 * Both ends of the conversation buffer: where a turn starts from, and where a
 * committed turn goes.
 *
 * `commit` is called by the loop at its durability boundary — the end of an
 * iteration, once every message it produced is final. It is NOT called on every
 * message mutation: an append-only writer attached to that would invalidate its
 * own on-disk prefix while the assistant message is still being revealed.
 * Implementations serialize their own writes; the loop may call `commit` again
 * before a previous call settles.
 */
export interface HistoryPort {
  /** The buffer a turn builds on. Sub-agents return a constant `[]`. */
  current(): MessageParam[];
  /** Persist. Receives the array to write — never re-read `current()` here. */
  commit(messages: MessageParam[]): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-turn options
// ────────────────────────────────────────────────────────────────────────────

export interface TurnOptions {
  maxTokens: number;
  maxTurns: number;
  /**
   * Consecutive `max_tokens` continuations the loop may grant before giving up.
   * Omit or `0` to hard-stop on the first truncation.
   */
  maxTokensContinuations?: number;
  /** Max tool executions in flight per turn. Omit or `<= 0` for unbounded. */
  toolConcurrency?: number;
  /** `> 0` asks the model to allocate that many tokens to extended thinking. */
  thinkingBudgetTokens?: number;
}

/**
 * Read once per turn, so `/model`, `/think`, `/effort` and `/config` take effect
 * on the next turn without rebuilding the agent (see the liveness rule).
 */
export interface OptionsProvider {
  turn(): TurnOptions;
}

// ────────────────────────────────────────────────────────────────────────────
// Tools
// ────────────────────────────────────────────────────────────────────────────

/**
 * The tool side of an agent, as one object: what exists, how to run it, and the
 * context a call runs in.
 *
 * `list()` is a method, not an array, because the set genuinely changes within a
 * session — MCP servers connect after startup and plan mode swaps the registry.
 * `contextFor()` is likewise per-turn; the loop fills in the abort `signal` and
 * the per-call `toolUseId` on top of what it returns.
 */
export interface ToolHost {
  list(): ToolDefinition[];
  execute(use: ToolUseBlock, ctx: ToolContext): Promise<ToolResultBlock>;
  contextFor(): ToolContext;
}

// ────────────────────────────────────────────────────────────────────────────
// Observability
// ────────────────────────────────────────────────────────────────────────────

/**
 * Structural subset of a pino logger — declared here so core stays a leaf and
 * never imports `@nova/base`. A pino `Logger` satisfies it as-is.
 */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Where recorded events go — in the CLI, `transcript.jsonl`.
 *
 * `kind` is a plain `string` here so core owns no transcript vocabulary; a sink
 * with a narrower kind union (runtime's `Transcript`) is wired through a thin
 * adapter rather than relying on TypeScript's method-parameter bivariance.
 */
export interface EventSink {
  append(record: { kind: string; data: unknown }): Promise<void>;
  flush(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Invariants
// ────────────────────────────────────────────────────────────────────────────

/** Raised when a mutation of the message history is not append-only. */
export class AppendOnlyViolationError extends Error {
  constructor(
    public readonly source: string,
    detail: string,
  ) {
    super(`${source} broke the append-only contract: ${detail}`);
    this.name = "AppendOnlyViolationError";
  }
}

/**
 * Assert that `next` is `prev` plus zero or more appended messages, comparing by
 * reference — an entry that was replaced in place fails even if it deep-equals
 * the original.
 *
 * The history is append-only end to end, compaction included: a compactor
 * returns the current history PLUS a new `<compacted>` boundary, it does not
 * replace or truncate. `persistMessages` relies on exactly that — it
 * append-fast-paths `messages.jsonl` while the on-disk prefix still matches, and
 * a silent truncation makes it fall back to a full rewrite, at which point
 * `messages.jsonl` and `transcript.jsonl` start disagreeing about what happened.
 * Nothing checked this before: hook-returned arrays went straight into the
 * history unverified.
 */
export function assertAppendOnly(
  prev: readonly MessageParam[],
  next: readonly MessageParam[],
  source = "history mutation",
): void {
  if (next === prev) return;
  if (next.length < prev.length) {
    throw new AppendOnlyViolationError(
      source,
      `history shrank from ${prev.length} to ${next.length} messages`,
    );
  }
  for (let i = 0; i < prev.length; i++) {
    if (next[i] !== prev[i]) {
      throw new AppendOnlyViolationError(
        source,
        `message at index ${i} was replaced (roles ${prev[i]?.role} → ${next[i]?.role})`,
      );
    }
  }
}
