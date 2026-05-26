import type {
  AssistantTurn,
  MessageParam,
  StopReason,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

/**
 * Single source of truth for hook points.
 *
 * Naming convention:
 * - `pre_<subject>` fires **before** something happens.
 * - `post_<subject>` fires **after** something happened.
 * - Bare-noun names (`error`) are reserved for events that don't fit a
 *   pre/post lifecycle.
 *
 * A hook is **advisory** when its `decision` is `void` — thrown errors are
 * swallowed, return values discarded. A hook is **blocking** otherwise — the
 * first non-`undefined` return wins, and thrown errors propagate up through
 * the loop.
 *
 * Some points are fired by `agentLoop` itself; others are fired only by the
 * caller (e.g. `@nova/agent` fires `pre_user_prompt` / `post_turn` / `error`
 * around the loop invocation). The HookSpec is the union of both — what
 * matters at the type level is the contract, not who fires.
 */
export interface HookSpec {
  // ── turn lifecycle (fired by the caller wrapping agentLoop) ───────────
  /**
   * Fires before the turn does anything else, with the raw user input.
   * Decide-able: rewrite the input or veto the whole turn.
   */
  pre_user_prompt: {
    payload: { input: string };
    decision: { input: string } | { abort: true; reason?: string };
  };
  /** Fires once at the very end of a turn (success / abort / error). */
  post_turn: {
    payload: {
      ok: boolean;
      aborted: boolean;
      error?: string;
      turns: number;
      stopReason?: StopReason;
      totalUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
      };
    };
    decision: void;
  };
  /** Fires on turn-level failures (loop throws, pre_user_prompt throws). */
  error: {
    payload: { message: string; stack?: string };
    decision: void;
  };

  // ── model request (fired by agentLoop) ───────────────────────────────
  /**
   * Fires immediately before every `model.call`. Advisory subscribers (UI
   * spinners) return `undefined`; policy hooks return a partial override of
   * any of `system / messages / tools / maxTokens / thinkingBudgetTokens`.
   */
  pre_request: {
    payload: {
      system: string;
      messages: MessageParam[];
      tools: ToolDefinition[];
      maxTokens: number;
      thinkingBudgetTokens?: number;
    };
    decision: {
      system?: string;
      messages?: MessageParam[];
      tools?: ToolDefinition[];
      maxTokens?: number;
      thinkingBudgetTokens?: number;
    };
  };
  /** Fires after `model.call` returns or throws. */
  post_request: {
    payload: {
      startedAt: number;
      endedAt: number;
      durationMs: number;
      usage?: AssistantTurn["usage"];
      stopReason?: StopReason;
      error?: string;
    };
    decision: void;
  };

  // ── assistant ─────────────────────────────────────────────────────────
  /** Fires after the model emits an assistant turn (text + tool_use blocks). */
  post_assistant: { payload: AssistantTurn; decision: void };

  // ── tool flow (fired by agentLoop) ────────────────────────────────────
  /** Fires when the loop is about to ask `pre_tool_use` for a tool call. */
  pre_permission: {
    payload: { tool: string; toolUseId: string };
    decision: void;
  };
  /**
   * The single permission gate. Pure notifications return `undefined`; policy
   * hooks return `{ allow: false, reason }` to deny — the loop synthesizes an
   * is_error tool_result, the same shape a deny used to produce.
   *
   * Payload mirrors `post_tool_use`'s shape so hooks can read `use.name`,
   * `use.id` (for correlation with permission events), and `use.input` from
   * a single object.
   */
  pre_tool_use: {
    payload: { use: ToolUseBlock };
    decision: { allow: false; reason: string };
  };
  /** Fires after the permission decision lands. */
  post_permission: {
    payload: { tool: string; toolUseId: string; granted: boolean; reason?: string };
    decision: void;
  };
  /**
   * Fires after `executeTool` returns and before the loop folds the result
   * into the message history. Pure notifications return `undefined`;
   * transformers return `{ result }` (redaction, truncation, ...).
   */
  post_tool_use: {
    payload: { use: ToolUseBlock; result: ToolResultBlock };
    decision: { result: ToolResultBlock };
  };
  /**
   * Fires after a user message lands — either the initial user input (fired
   * by the caller) or a tool_result batch (fired by the loop).
   */
  post_user_message: { payload: MessageParam; decision: void };

  // ── iteration boundary (fired by agentLoop) ──────────────────────────
  /**
   * Fires at the end of each loop iteration that had tool_uses, before the
   * next pre_compact / pre_request. Used to inject extra messages (e.g. todo
   * reminders). Returns `{ messages }` to append; `undefined` for no-op.
   */
  pre_continue: {
    payload: { turn: number; toolUses: ToolUseBlock[] };
    decision: { messages: MessageParam[] };
  };

  // ── compaction (fired by agentLoop) ──────────────────────────────────
  /**
   * Fires at the top of every loop iteration. Returns `{ messages }` to swap
   * the working history (compaction happened); `undefined` for no-op.
   */
  pre_compact: {
    payload: { messages: MessageParam[] };
    decision: { messages: MessageParam[] };
  };
  /** Fires after compaction actually replaced the history. */
  post_compact: {
    payload: { before: number; after: number; transcriptPath?: string };
    decision: void;
  };

  // ── message-stream / stop ────────────────────────────────────────────
  /** Fires on every mutation of the canonical messages array. */
  post_messages: { payload: { messages: MessageParam[] }; decision: void };
  /** Fires when the loop hits a terminating stop_reason. */
  post_stop: { payload: { reason: StopReason; message?: string }; decision: void };
}

export type HookPoint = keyof HookSpec;
export type HookPayload<K extends HookPoint> = HookSpec[K]["payload"];
export type HookDecision<K extends HookPoint> = HookSpec[K]["decision"];

export type HookFn<K extends HookPoint> = (
  payload: HookPayload<K>,
) => HookDecision<K> | void | Promise<HookDecision<K> | void>;

const BLOCKING_POINTS: ReadonlySet<HookPoint> = new Set<HookPoint>([
  "pre_user_prompt",
  "pre_request",
  "pre_tool_use",
  "post_tool_use",
  "pre_continue",
  "pre_compact",
]);

export function isBlockingPoint(point: HookPoint): boolean {
  return BLOCKING_POINTS.has(point);
}

interface HookErrorReporter {
  (point: HookPoint, err: unknown): void;
}

// Internal storage type. TS's function parameter contravariance makes a
// straight `HookFn<HookPoint>` cast look unsafe; double-casting through
// `unknown` to `AnyHook` documents the intent — every call site re-narrows
// by point.
type AnyHook = (payload: unknown) => unknown;

/**
 * Typed pub/sub for hook callbacks.
 *
 * - `on(point, fn)` registers a hook; returns an unsubscribe function.
 * - `runAdvisory(point, payload)` fires every registered hook in registration
 *   order, swallowing thrown errors and discarding return values.
 * - `runBlocking(point, payload)` fires hooks in order; the first non-
 *   `undefined` return short-circuits and is returned to the caller. Thrown
 *   errors propagate.
 */
export class HookRegistry {
  private hooks: Map<HookPoint, Set<AnyHook>> = new Map();

  private onError: HookErrorReporter | undefined;

  constructor(onError?: HookErrorReporter) {
    this.onError = onError;
  }

  on<K extends HookPoint>(point: K, fn: HookFn<K>): () => void {
    const set = this.hooks.get(point) ?? new Set<AnyHook>();
    const stored = fn as unknown as AnyHook;
    set.add(stored);
    this.hooks.set(point, set);
    return () => {
      set.delete(stored);
    };
  }

  async runAdvisory<K extends HookPoint>(point: K, payload: HookPayload<K>): Promise<void> {
    const set = this.hooks.get(point);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        await (fn as unknown as HookFn<K>)(payload);
      } catch (err) {
        this.onError?.(point, err);
      }
    }
  }

  async runBlocking<K extends HookPoint>(
    point: K,
    payload: HookPayload<K>,
  ): Promise<HookDecision<K> | undefined> {
    const set = this.hooks.get(point);
    if (!set || set.size === 0) return undefined;
    for (const fn of [...set]) {
      const result = await (fn as unknown as HookFn<K>)(payload);
      if (result !== undefined) return result as HookDecision<K>;
    }
    return undefined;
  }
}
