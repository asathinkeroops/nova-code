import {
  agentLoop,
  blocksOf,
  HookRegistry,
  markSynthetic,
  userText,
  type HookFn,
  type HookPoint,
  type MessageMeta,
  type MessageParam,
  type ModelClient,
  type PermissionResult,
  type StopReason,
  type ToolDefinition,
  type ToolExecutor,
  type FileAccessLedger,
  type AskUserFn,
} from "@nova/core";
import type { MemoryBundle } from "./memory.js";
import type { Logger, Transcript, TranscriptKind } from "@nova/runtime";
import { buildSystemPrompt } from "./system-prompt.js";
import { persistMessages, type PersistCursor } from "./persistence.js";

/**
 * Per-turn knobs the agent reads from settings. A slice rather than the full
 * `@nova/runtime` Settings type so the agent stays uncoupled from the schema.
 */
export interface AgentSettingsSlice {
  maxTokens: number;
  maxTurns: number;
  /**
   * Consecutive max_tokens continuations the loop may grant before giving up.
   * Omit or `0` to hard-stop on the first truncation. Forwarded to `agentLoop`.
   */
  maxTokensContinuations?: number;
  /** When true, skips transcript.append for every advisory hook. */
  noTranscript: boolean;
  /**
   * Max tool executions to run concurrently within a turn. Omit (or `<= 0`)
   * for unbounded. Forwarded to `agentLoop`.
   */
  toolConcurrency?: number;
  /** The active model's input modalities. Forwarded to ToolContext for tools that need it. */
  modelModalities?: { input: readonly ("text" | "image")[] };
  /**
   * Current reasoning-effort level. Forwarded to ToolContext so authored
   * content can reference it; read per turn because `/effort` changes it
   * in-session.
   */
  effort?: string;
  /**
   * Resolved UI/response language tag (e.g. "en", "zh-CN") the model is told to
   * reply in. "auto" is resolved to the system locale before it reaches here
   * (see resolveLanguage). Forwarded to `buildSystemPrompt`; omit to default to
   * English.
   */
  language?: string;
}

/**
 * Inputs to `createAgent`. Identity / model / settings / memory live behind
 * getters so the agent transparently sees CLI-side mutations (e.g. /resume,
 * /think, a session-boundary memory reload) on the next turn. `workspace` is
 * the one stable value passed by reference.
 *
 * Built-in capabilities (`checkPermission`, `compactor`) are still accepted
 * as deps for ergonomic reasons — `createAgent` registers them as
 * `pre_tool_use` / `pre_compact` hooks on the shared `HookRegistry`.
 * Callers who want to register *additional* hooks at those points (or any
 * other point, e.g. `pre_continue` for reminders, `pre_request` for
 * notifiers) do so via `agent.on(...)` after construction; first-match-wins
 * gives them a way to override the defaults.
 */
export interface AgentDeps {
  workspace: string;
  /**
   * The memory bundle, read fresh each turn. Behind a getter (not a value) so a
   * session-boundary reload (`/clear`, `/resume`) is reflected on the next turn.
   * MUST return a reference that is stable WITHIN a session — the bundle is
   * embedded in the `system` prompt (byte 0 of the prefix), so a mid-session
   * change would collapse DeepSeek's prefix cache. See the prefix-caching
   * contract in CLAUDE.md.
   */
  getMemory: () => MemoryBundle;
  skillsBlock: string;

  // identity — varies across /resume
  getSessionId: () => string;
  getMessagesPath: () => string;
  getTranscript: () => Transcript;
  getLogger: () => Logger;
  getPersistCursor: () => PersistCursor;
  setPersistCursor: (cursor: PersistCursor) => void;

  // model / thinking — thinking varies across /think
  getModel: () => ModelClient;
  getThinkingBudget: () => number;

  // settings slice
  getSettings: () => AgentSettingsSlice;

  // capabilities
  getTools: () => ToolDefinition[];
  dispatch: ToolExecutor;
  checkPermission: (tool: string, input: unknown) => Promise<PermissionResult>;
  compactor: (messages: MessageParam[]) => Promise<MessageParam[]>;
  fileLedger: FileAccessLedger;
  askUser: AskUserFn;

  /** Returns the canonical pre-turn message buffer (e.g. CLI's screen store). */
  getMessages: () => MessageParam[];

  /**
   * Optional system-prompt override. When provided, `runTurn` uses its return
   * value verbatim instead of building one from workspace/memory/skills via
   * `buildSystemPrompt`. Sub-agents use this to install a task-focused role
   * prompt; the main agent leaves it undefined.
   */
  getSystemPrompt?: () => string;
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
   * function. See `@nova/core`'s `HookSpec` for the full set of points.
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
   * Flush the current messages buffer to disk using the deps' cursor. Used by
   * `/clear`, `/compact`, `/resume` to persist out-of-band mutations.
   */
  persist(messages?: MessageParam[]): Promise<void>;

  /** The in-flight turn's AbortSignal, or undefined when idle. */
  currentSignal(): AbortSignal | undefined;

  /** Abort the in-flight turn (if any). No-op when idle. */
  abort(reason?: unknown): void;
}

/**
 * Subset of HookSpec points the agent mirrors into the on-disk transcript.
 * Excludes `post_messages` (every mutation is captured by other records),
 * `pre_*` blocking points (decision rather than event), and the turn-level
 * `error` / `post_turn` (the agent writes these explicitly).
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

export function createAgent(deps: AgentDeps): Agent {
  const hooks = new HookRegistry((point, err) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    deps.getLogger().warn({ err: msg, point }, "advisory hook threw");
  });
  let activeController: AbortController | null = null;

  // ── built-in adapters: deps → hooks ─────────────────────────────────────
  // Register first so user hooks (registered later via agent.on) run after
  // and can override the defaults via short-circuit decisions.

  hooks.on("pre_tool_use", async ({ use }) => {
    const result = await deps.checkPermission(use.name, use.input);
    if (result.granted) return undefined;
    return { allow: false, reason: result.reason ?? "denied" };
  });

  hooks.on("pre_compact", async ({ messages }) => {
    const next = await deps.compactor(messages);
    if (next === messages) return undefined;
    return { messages: next };
  });

  // ── transcript writer: one advisory hook per recorded point ─────────────
  for (const point of TRANSCRIPT_POINTS) {
    hooks.on(point, (payload) => {
      if (deps.getSettings().noTranscript) return;
      void deps.getTranscript().append({
        kind: point as TranscriptKind,
        data: payload as unknown,
      });
    });
  }

  // Serializes every write to messages.jsonl. `persistMessages` is a
  // read-cursor → write → write-cursor sequence with an await in the middle, so
  // two overlapping calls would both read the same cursor and each append the
  // same delta. Writes are frequent now that every loop iteration commits (see
  // the post_commit hook below), so the chain is load-bearing, not belt-and-braces.
  let persistChain: Promise<unknown> = Promise.resolve();

  const persist = (messages?: MessageParam[]): Promise<void> => {
    const run = persistChain.then(async () => {
      // Read at run time, not call time: a queued call must see the newest
      // buffer, not the one that was current when it was enqueued.
      const msgs = messages ?? deps.getMessages();
      try {
        const cursor = await persistMessages(deps.getMessagesPath(), msgs, deps.getPersistCursor());
        deps.setPersistCursor(cursor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.getLogger().error({ err: msg }, "failed to persist messages");
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
  // turn), `post_commit` gives the newest *sealed* one (safe to write).
  let latestMessages: MessageParam[] | null = null;
  let lastCommitted: MessageParam[] | null = null;
  // How far `recordInjections` has already scanned this turn.
  let recordedCount = 0;

  hooks.on("post_messages", ({ messages }) => {
    latestMessages = messages;
  });

  /**
   * Mirror nova-authored messages into the transcript. The compaction summary,
   * reminders and notifications enter history through `pre_compact` /
   * `pre_continue` / `pre_request`, which fire none of the hooks the other
   * records mirror — so a transcript read alone could not otherwise show what
   * the model was actually told. `meta.synthetic` is the discriminator; model
   * and tool output never carry it, so nothing is double-recorded.
   */
  const recordInjections = (messages: MessageParam[]): void => {
    const from = recordedCount;
    recordedCount = messages.length;
    if (deps.getSettings().noTranscript) return;
    const transcript = deps.getTranscript();
    for (let i = from; i < messages.length; i++) {
      const meta = messages[i]?.meta;
      if (!meta?.synthetic) continue;
      void transcript.append({
        kind: "message_injected",
        // `index` aligns the record with the same message in messages.jsonl.
        data: { index: i, kind: meta.kind, message: messages[i] },
      });
    }
  };

  // Flush at every durability boundary rather than only at turn end, so an
  // interrupt or a crash costs at most the in-flight tool round-trip instead of
  // the whole turn. Writes the payload — NOT deps.getMessages(), which sub-agents
  // wire to a constant empty array.
  hooks.on("post_commit", async ({ messages }) => {
    lastCommitted = messages;
    try {
      await persist(messages);
    } catch {
      // already logged in persist(); the turn-end flush will retry
    }
    recordInjections(messages);
  });

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

    const transcript = deps.getTranscript();
    const logger = deps.getLogger();
    const settings = deps.getSettings();
    const budget = deps.getThinkingBudget();

    let result: Awaited<ReturnType<typeof agentLoop>> | null = null;
    let aborted = false;
    let error: Error | undefined;
    try {
      result = await agentLoop({
        model: deps.getModel(),
        system: deps.getSystemPrompt
          ? deps.getSystemPrompt()
          : buildSystemPrompt(
              deps.workspace,
              deps.getMemory(),
              deps.getSessionId(),
              deps.skillsBlock,
              settings.language,
            ),
        tools: deps.getTools(),
        executeTool: deps.dispatch,
        messages: baseMessages,
        maxTokens: settings.maxTokens,
        maxTurns: settings.maxTurns,
        ...(settings.maxTokensContinuations !== undefined
          ? { maxTokensContinuations: settings.maxTokensContinuations }
          : {}),
        toolContext: {
          cwd: deps.workspace,
          signal: controller.signal,
          fileLedger: deps.fileLedger,
          askUser: deps.askUser,
          modelModalities: settings.modelModalities,
          sessionId: deps.getSessionId(),
          ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
        },
        hooks,
        ...(budget > 0 ? { thinkingBudgetTokens: budget } : {}),
        ...(settings.toolConcurrency !== undefined
          ? { toolConcurrency: settings.toolConcurrency }
          : {}),
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
    // failed turn still produced real history, and the transcript already
    // recorded it happening — leaving it out of messages.jsonl is precisely the
    // divergence this is meant to prevent.
    try {
      await persist(finalMessages);
    } catch {
      // already logged in persist()
    }
    // Catches what no post_commit covered: injections in the final, tool-free
    // iteration (which returns instead of committing) and the interrupt marker.
    recordInjections(finalMessages);

    if (result) {
      logger.info(
        { turns: result.turns, stopReason: result.stopReason, usage: result.totalUsage },
        "loop finished",
      );
      await transcript.flush();
    } else if (aborted) {
      logger.info({}, "loop interrupted");
      if (!settings.noTranscript) {
        await transcript.append({ kind: "error", data: { message: "interrupted by user" } });
      }
      await transcript.flush();
    } else if (error) {
      const msg = error.stack ?? error.message;
      logger.error({ err: msg }, "loop terminated");
      if (!settings.noTranscript) {
        await transcript.append({ kind: "error", data: { message: msg } });
      }
      await transcript.flush();
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
            messages: deps.getMessages(),
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
        messages: deps.getMessages(),
        totalUsage,
      };
    }

    const baseMessages = [...deps.getMessages(), userText(effectiveInput, opts.meta)];

    // Immediate visual sync: surface the user message BEFORE the loop fires
    // its first post_messages (which only lands after model.call starts).
    await hooks.runAdvisory("post_messages", { messages: baseMessages });
    if (!deps.getSettings().noTranscript) {
      await deps.getTranscript().append({ kind: "user_prompt", data: { text: effectiveInput } });
    }

    return runLoop(baseMessages, opts);
  };

  // Resume the loop on the current buffer with no new user message. Out-of-band
  // injections (a background command completing) reach the model through the
  // `pre_request` hooks that fire inside `agentLoop`; the buffer carries no
  // synthetic user turn of its own.
  const continueTurn = (opts: { signal?: AbortSignal } = {}): Promise<TurnResult> =>
    runLoop([...deps.getMessages()], opts);

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
