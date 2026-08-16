import { HookRegistry, type HookFn, type HookPoint } from "./hooks.js";
import { agentLoop } from "./loop.js";
import { blocksOf, markSynthetic, userText } from "./messages.js";
import type { ModelClient } from "./model-client.js";
import {
  freezeSystemPrompt,
  type Compactor,
  type EventSink,
  type HistoryPort,
  type Logger,
  type OptionsProvider,
  type PermissionGate,
  type SystemPromptProvider,
  type ToolHost,
} from "./ports.js";
import type { MessageMeta, MessageParam, StopReason } from "./types.js";

/**
 * Everything an agent runs on, in one container.
 *
 * Constructed ONCE. Anything that changes mid-session lives behind a port
 * method, never in a field read at construction time — see the liveness rule in
 * `ports.ts`. The optional ports all degrade to a no-op, which is what makes a
 * sub-agent (no shared buffer, its own store, no host tools) the same
 * `createAgent` call with a different container rather than a second
 * implementation.
 */
export interface AgentContext {
  /** Model transport. Pass a stable forwarding client if the binding can change. */
  model: ModelClient;
  /** Produces `system`; frozen per epoch by `createAgent` (prefix-cache contract). */
  systemPrompt: SystemPromptProvider;
  /** Tool definitions, dispatch, and the per-call context. */
  tools: ToolHost;
  /** The buffer a turn starts from, and where a committed turn goes. */
  history: HistoryPort;
  /** Per-turn model parameters, read once per turn. */
  options: OptionsProvider;

  /** Omitted: no compaction. */
  compactor?: Compactor;
  /** Omitted: every tool call is granted. */
  permission?: PermissionGate;
  /** Omitted: silent. */
  logger?: Logger;
  /** Omitted: nothing is recorded (what `--no-transcript` means). */
  events?: EventSink;
  /** Omitted: the agent creates its own registry. */
  hooks?: HookRegistry;
}

export interface TurnResult {
  ok: boolean;
  aborted: boolean;
  error?: Error;
  turns: number;
  stopReason?: StopReason;
  messages: MessageParam[];
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export interface Agent {
  /**
   * Register a hook at a named lifecycle point. Returns an unsubscribe
   * function. See `HookSpec` for the full set of points.
   */
  on<K extends HookPoint>(point: K, fn: HookFn<K>): () => void;

  /**
   * Run one user turn: fire `pre_user_prompt`, drive `agentLoop` to
   * completion, fire `post_turn`. Never throws — all failures land on the
   * returned `TurnResult` and the `error` hook.
   */
  runTurn(input: string, opts?: { signal?: AbortSignal; meta?: MessageMeta }): Promise<TurnResult>;

  /**
   * Resume the loop on the CURRENT message buffer without appending a user
   * message. Used to wake the agent for out-of-band injections (e.g. a
   * background command completing): `pre_request` hooks fire and may inject,
   * then the model responds. Fires `post_turn`; never throws.
   */
  continueTurn(opts?: { signal?: AbortSignal }): Promise<TurnResult>;

  /**
   * Flush the current messages buffer through the history port. Used by
   * `/clear`, `/compact`, `/rewind`, `/resume` to persist out-of-band mutations.
   */
  persist(messages?: MessageParam[]): Promise<void>;

  /** The in-flight turn's AbortSignal, or undefined when idle. */
  currentSignal(): AbortSignal | undefined;

  /** Abort the in-flight turn (if any). No-op when idle. */
  abort(reason?: unknown): void;
}

/**
 * Hook points mirrored into the event sink. Excludes `post_messages` (every
 * mutation is captured by other records), the `pre_*` blocking points (decision
 * rather than event), and the turn-level `error` / `post_turn` (written
 * explicitly below).
 */
const TRANSCRIPT_POINTS: ReadonlyArray<HookPoint> = [
  "post_assistant",
  "post_request",
  "pre_permission",
  "post_permission",
  "post_user_message",
  "post_stop",
  "post_compact",
];

export function createAgent(ctx: AgentContext): Agent {
  const logger = ctx.logger;
  const hooks =
    ctx.hooks ??
    new HookRegistry((point, err) => {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      logger?.warn({ err: msg, point }, "advisory hook threw");
    });
  const events = ctx.events;
  let activeController: AbortController | null = null;

  // The prefix-cache contract, enforced rather than documented: `system` is byte
  // 0 of every request, so it may only change when the epoch (the session) does.
  const systemPrompt = freezeSystemPrompt(ctx.systemPrompt, {
    onDrift: (drift) =>
      logger?.warn(
        { epoch: drift.epoch },
        "system prompt changed within a session — the frozen value was kept",
      ),
  });

  // ── event mirror: one advisory hook per recorded point ──────────────────
  for (const point of TRANSCRIPT_POINTS) {
    hooks.on(point, (payload) => {
      if (!events) return;
      void events.append({ kind: point, data: payload as unknown });
    });
  }

  // Serializes every write. `commit` is a read-cursor → write → write-cursor
  // sequence with an await in the middle, so two overlapping calls would both
  // read the same cursor and each append the same delta. Writes are frequent
  // now that every loop iteration commits, so the chain is load-bearing.
  let persistChain: Promise<unknown> = Promise.resolve();

  const persist = (messages?: MessageParam[]): Promise<void> => {
    const run = persistChain.then(async () => {
      // Read at run time, not call time: a queued call must see the newest
      // buffer, not the one that was current when it was enqueued.
      const msgs = messages ?? ctx.history.current();
      try {
        await ctx.history.commit(msgs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.error({ err: msg }, "failed to persist messages");
        throw err;
      }
    });
    // A failed write must not poison the queue for later callers.
    persistChain = run.catch(() => undefined);
    return run;
  };

  // ── durability ──────────────────────────────────────────────────────────
  // The loop's own view of history is unreachable once it throws, so mirror it
  // here: `post_messages` gives the newest array (used to rescue an interrupted
  // turn), the loop's commit boundary gives the newest *sealed* one.
  let latestMessages: MessageParam[] | null = null;
  let lastCommitted: MessageParam[] | null = null;
  // How far `recordInjections` has already scanned this turn.
  let recordedCount = 0;

  hooks.on("post_messages", ({ messages }) => {
    latestMessages = messages;
  });

  /**
   * Mirror nova-authored messages into the event sink. The compaction summary,
   * reminders and notifications enter history through the compactor /
   * `pre_continue` / `pre_request`, which fire none of the hooks the other
   * records mirror — so a transcript read alone could not otherwise show what
   * the model was actually told. `meta.synthetic` is the discriminator; model
   * and tool output never carry it, so nothing is double-recorded.
   */
  const recordInjections = (messages: MessageParam[]): void => {
    const from = recordedCount;
    recordedCount = messages.length;
    if (!events) return;
    for (let i = from; i < messages.length; i++) {
      const meta = messages[i]?.meta;
      if (!meta?.synthetic) continue;
      void events.append({
        kind: "message_injected",
        // `index` aligns the record with the same message in messages.jsonl.
        data: { index: i, kind: meta.kind, message: messages[i] },
      });
    }
  };

  const emitPostTurn = (payload: {
    ok: boolean;
    aborted: boolean;
    error?: string;
    turns: number;
    stopReason?: StopReason;
    totalUsage: TurnResult["totalUsage"];
  }): Promise<void> => hooks.runAdvisory("post_turn", payload);

  /**
   * Drive `agentLoop` over a prepared message buffer to completion: wire the
   * AbortController, run the loop, persist, fire `post_turn`, and shape the
   * `TurnResult`. Shared by `runTurn` (which prepends a user message first) and
   * `continueTurn` (which resumes the current buffer unchanged). Never throws.
   */
  const runLoop = async (
    baseMessages: MessageParam[],
    opts: { signal?: AbortSignal },
  ): Promise<TurnResult> => {
    // Scoped to this turn: a leftover array from the previous one is a strict
    // prefix of `baseMessages`, so rescuing from it would silently drop the
    // messages this turn starts with.
    latestMessages = null;
    lastCommitted = null;
    // Everything already in the buffer is either previously recorded or the
    // user prompt, which `runTurn` records itself.
    recordedCount = baseMessages.length;

    const controller = new AbortController();
    activeController = controller;
    const externalSignal = opts.signal;
    const onExternalAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(externalSignal?.reason);
      }
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const turnOptions = ctx.options.turn();

    let result: Awaited<ReturnType<typeof agentLoop>> | null = null;
    let aborted = false;
    let error: Error | undefined;
    try {
      result = await agentLoop({
        model: ctx.model,
        system: await systemPrompt.system(),
        tools: ctx.tools.list(),
        executeTool: (use, toolCtx) => ctx.tools.execute(use, toolCtx),
        messages: baseMessages,
        maxTokens: turnOptions.maxTokens,
        maxTurns: turnOptions.maxTurns,
        ...(turnOptions.maxTokensContinuations !== undefined
          ? { maxTokensContinuations: turnOptions.maxTokensContinuations }
          : {}),
        ...(turnOptions.toolConcurrency !== undefined
          ? { toolConcurrency: turnOptions.toolConcurrency }
          : {}),
        ...(turnOptions.thinkingBudgetTokens && turnOptions.thinkingBudgetTokens > 0
          ? { thinkingBudgetTokens: turnOptions.thinkingBudgetTokens }
          : {}),
        toolContext: { ...ctx.tools.contextFor(), signal: controller.signal },
        hooks,
        ...(ctx.compactor ? { compactor: ctx.compactor } : {}),
        ...(ctx.permission ? { permission: ctx.permission } : {}),
        // Route the loop's commits through the same serialized path as
        // out-of-band persists, so the two can never interleave mid-write.
        history: {
          commit: async (messages) => {
            lastCommitted = messages;
            try {
              await persist(messages);
            } catch {
              // already logged in persist(); the turn-end flush will retry
            }
            recordInjections(messages);
          },
        },
      });
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      aborted = controller.signal.aborted;
    } finally {
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      activeController = null;
    }

    // When the loop throws, its return value is gone but the history it built
    // is not — the hooks above mirrored it. Prefer the newest array; fall back
    // to the last sealed commit when that array has a tool_use still awaiting
    // its result, which is what a hook throwing mid-dispatch leaves behind.
    // Persisting an unpaired tool_use would make the session unresumable: the
    // next request would be rejected before the model ever saw it.
    const rescued = pairingIsComplete(latestMessages) ? latestMessages : lastCommitted;
    let finalMessages = result?.messages ?? rescued ?? baseMessages;
    const totalUsage = result?.totalUsage ?? zeroUsage();

    if (aborted) {
      finalMessages = [
        ...finalMessages,
        markSynthetic(
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "<interrupted>The previous operation was cancelled by the user.</interrupted>",
              },
            ],
          },
          "interrupted",
        ),
      ];
      // Publish before persisting. The marker is appended here rather than by
      // the loop, so without this the caller's buffer (the CLI screen store,
      // which is what the NEXT turn builds on) would not have it — and that
      // turn's write would then read as a divergence from the on-disk prefix,
      // forcing a full rewrite that drops the marker again.
      await hooks.runAdvisory("post_messages", { messages: finalMessages });
    }

    // Persist on every exit path, not just the clean one. An interrupted or
    // failed turn still produced real history, and the events already recorded
    // it happening — leaving it out of messages.jsonl is precisely the
    // divergence this is meant to prevent.
    try {
      await persist(finalMessages);
    } catch {
      // already logged in persist()
    }
    // Catches what no commit covered: injections in the final, tool-free
    // iteration (which returns instead of committing) and the interrupt marker.
    recordInjections(finalMessages);

    if (result) {
      logger?.info(
        { turns: result.turns, stopReason: result.stopReason, usage: result.totalUsage },
        "loop finished",
      );
      await events?.flush();
    } else if (aborted) {
      logger?.info({}, "loop interrupted");
      await events?.append({ kind: "error", data: { message: "interrupted by user" } });
      await events?.flush();
    } else if (error) {
      const msg = error.stack ?? error.message;
      logger?.error({ err: msg }, "loop terminated");
      await events?.append({ kind: "error", data: { message: msg } });
      await events?.flush();
      await hooks.runAdvisory("error", {
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      });
    }

    const ok = !!result;
    await emitPostTurn({
      ok,
      aborted,
      turns: result?.turns ?? 0,
      ...(result?.stopReason ? { stopReason: result.stopReason } : {}),
      ...(!ok && !aborted && error ? { error: error.message } : {}),
      totalUsage,
    });

    return {
      ok,
      aborted,
      ...(error ? { error } : {}),
      turns: result?.turns ?? 0,
      ...(result?.stopReason ? { stopReason: result.stopReason } : {}),
      messages: finalMessages,
      totalUsage,
    };
  };

  const runTurn = async (
    input: string,
    opts: { signal?: AbortSignal; meta?: MessageMeta } = {},
  ): Promise<TurnResult> => {
    // ── pre_user_prompt (blocking) ────────────────────────────────────────
    let effectiveInput = input;
    try {
      const pre = await hooks.runBlocking("pre_user_prompt", { input });
      if (pre) {
        if ("abort" in pre && pre.abort) {
          const totalUsage = zeroUsage();
          await emitPostTurn({
            ok: false,
            aborted: true,
            turns: 0,
            totalUsage,
            ...(pre.reason ? { error: pre.reason } : {}),
          });
          return {
            ok: false,
            aborted: true,
            turns: 0,
            messages: ctx.history.current(),
            totalUsage,
          };
        }
        if ("input" in pre && pre.input !== undefined) {
          effectiveInput = pre.input;
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await hooks.runAdvisory("error", {
        message: e.message,
        ...(e.stack ? { stack: e.stack } : {}),
      });
      const totalUsage = zeroUsage();
      await emitPostTurn({
        ok: false,
        aborted: false,
        turns: 0,
        error: e.message,
        totalUsage,
      });
      return {
        ok: false,
        aborted: false,
        error: e,
        turns: 0,
        messages: ctx.history.current(),
        totalUsage,
      };
    }

    const baseMessages = [...ctx.history.current(), userText(effectiveInput, opts.meta)];

    // Immediate visual sync: surface the user message BEFORE the loop fires
    // its first post_messages (which only lands after model.call starts).
    await hooks.runAdvisory("post_messages", { messages: baseMessages });
    await events?.append({ kind: "user_prompt", data: { text: effectiveInput } });

    return runLoop(baseMessages, opts);
  };

  // Resume the loop on the current buffer with no new user message. Out-of-band
  // injections (a background command completing) reach the model through the
  // `pre_request` hooks that fire inside `agentLoop`; the buffer carries no
  // synthetic user turn of its own.
  const continueTurn = (opts: { signal?: AbortSignal } = {}): Promise<TurnResult> =>
    runLoop([...ctx.history.current()], opts);

  return {
    on: (point, fn) => hooks.on(point, fn),
    runTurn,
    continueTurn,
    persist,
    currentSignal: () => activeController?.signal,
    abort: (reason) => {
      if (activeController && !activeController.signal.aborted) {
        activeController.abort(reason);
      }
    },
  };
}

/**
 * True when every `tool_use` in `messages` has a matching `tool_result`. The
 * loop guarantees this for histories it returns or commits, but a mid-dispatch
 * throw can leave a gap, and an unpaired tool_use is rejected by the API on the
 * next request — so it must never be written to the replayable history.
 */
function pairingIsComplete(messages: MessageParam[] | null): messages is MessageParam[] {
  if (!messages) return false;
  const awaiting = new Set<string>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (block.type === "tool_use") awaiting.add(block.id);
      else if (block.type === "tool_result") awaiting.delete(block.tool_use_id);
    }
  }
  return awaiting.size === 0;
}

function zeroUsage(): TurnResult["totalUsage"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}
