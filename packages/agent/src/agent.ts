import {
  agentLoop,
  HookRegistry,
  userText,
  type HookFn,
  type HookPoint,
  type MessageParam,
  type ModelClient,
  type PermissionResult,
  type StopReason,
  type ToolDefinition,
  type ToolExecutor,
  type FileAccessLedger,
  type AskUserFn,
} from "@nova/core";
import type { MemoryBundle } from "@nova/context";
import type { Transcript, TranscriptKind } from "@nova/observability";
import type { Logger } from "@nova/runtime";
import { buildSystemPrompt } from "./system-prompt.js";
import { persistMessages, type PersistCursor } from "./persistence.js";

/**
 * Per-turn knobs the agent reads from settings. A slice rather than the full
 * `@nova/runtime` Settings type so the agent stays uncoupled from the schema.
 */
export interface AgentSettingsSlice {
  maxTokens: number;
  maxTurns: number;
  /** When true, skips transcript.append for every advisory hook. */
  noTranscript: boolean;
}

/**
 * Inputs to `createAgent`. Identity / model / settings live behind getters so
 * the agent transparently sees CLI-side mutations (e.g. /model, /resume) on
 * the next turn. Stable values (workspace, memory) are passed by reference.
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
  memory: MemoryBundle;
  skillsBlock: string;

  // identity — varies across /resume
  getSessionId: () => string;
  getMessagesPath: () => string;
  getTranscript: () => Transcript;
  getLogger: () => Logger;
  getPersistCursor: () => PersistCursor;
  setPersistCursor: (cursor: PersistCursor) => void;

  // model / thinking — vary across /model and /think
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
  runTurn(input: string, opts?: { signal?: AbortSignal }): Promise<TurnResult>;

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

  const persist = async (messages?: MessageParam[]): Promise<void> => {
    const msgs = messages ?? deps.getMessages();
    try {
      const cursor = await persistMessages(
        deps.getMessagesPath(),
        msgs,
        deps.getPersistCursor(),
      );
      deps.setPersistCursor(cursor);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.getLogger().error({ err: msg }, "failed to persist messages");
      throw err;
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

  const runTurn = async (
    input: string,
    opts: { signal?: AbortSignal } = {},
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
    const baseMessages = [...deps.getMessages(), userText(effectiveInput)];

    // Immediate visual sync: surface the user message BEFORE the loop fires
    // its first post_messages (which only lands after model.call starts).
    await hooks.runAdvisory("post_messages", { messages: baseMessages });
    if (!settings.noTranscript) {
      await transcript.append({ kind: "user_prompt", data: { text: effectiveInput } });
    }

    const budget = deps.getThinkingBudget();

    let result: Awaited<ReturnType<typeof agentLoop>> | null = null;
    let aborted = false;
    let error: Error | undefined;
    try {
      result = await agentLoop({
        model: deps.getModel(),
        system: buildSystemPrompt(
          deps.workspace,
          deps.memory,
          deps.getSessionId(),
          deps.skillsBlock,
        ),
        tools: deps.getTools(),
        executeTool: deps.dispatch,
        messages: baseMessages,
        maxTokens: settings.maxTokens,
        maxTurns: settings.maxTurns,
        toolContext: {
          cwd: deps.workspace,
          signal: controller.signal,
          fileLedger: deps.fileLedger,
          askUser: deps.askUser,
        },
        hooks,
        ...(budget > 0 ? { thinkingBudgetTokens: budget } : {}),
      });
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      aborted = controller.signal.aborted;
    } finally {
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      activeController = null;
    }

    const finalMessages = result?.messages ?? baseMessages;
    const totalUsage = result?.totalUsage ?? zeroUsage();

    if (result) {
      try {
        await persist(finalMessages);
      } catch {
        // already logged in persist()
      }
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

  return {
    on: (point, fn) => hooks.on(point, fn),
    runTurn,
    persist,
    currentSignal: () => activeController?.signal,
    abort: (reason) => {
      if (activeController && !activeController.signal.aborted) {
        activeController.abort(reason);
      }
    },
  };
}

function zeroUsage(): TurnResult["totalUsage"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}
