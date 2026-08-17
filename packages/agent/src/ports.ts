/**
 * Port implementations for `@nova/core`'s `createAgent`.
 *
 * core owns the interfaces and the call order; this file owns the concrete
 * behavior — the memory-backed system prompt, the `messages.jsonl` store, the
 * transcript sink, and the tool host.
 *
 * Every factory here takes GETTERS for anything that changes within a session
 * (model, logger, transcript, settings, session id) and returns a stable object
 * that reads them per call. That is the liveness rule from `core/ports.ts`: the
 * container is built once, so live bindings have to sit behind a method.
 */

import type {
  AskUserFn,
  EventSink,
  FileAccessLedger,
  Logger,
  MessageParam,
  ModelClient,
  OptionsProvider,
  SystemPromptProvider,
  ToolDefinition,
  ToolExecutor,
  ToolHost,
  TurnOptions,
} from "@nova/core";
import type { Logger as RuntimeLogger, Transcript } from "@nova/base";
import type { MemoryBundle } from "./memory.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { persistMessages, type PersistCursor } from "./persistence.js";

/**
 * Per-turn knobs the agent reads from settings. A slice rather than the full
 * `@nova/base` Settings type so the agent stays uncoupled from the schema.
 *
 * `language` lives on the system-prompt provider and `noTranscript` is expressed
 * by simply not wiring an event sink, so neither appears here.
 */
export interface AgentSettingsSlice {
  maxTokens: number;
  maxTurns: number;
  /**
   * Consecutive max_tokens continuations the loop may grant before giving up.
   * Omit or `0` to hard-stop on the first truncation.
   */
  maxTokensContinuations?: number;
  /** Max tool executions to run concurrently within a turn. Omit for unbounded. */
  toolConcurrency?: number;
  /** The active model's input modalities. Forwarded to ToolContext. */
  modelModalities?: { input: readonly ("text" | "image")[] };
  /** Current reasoning-effort level; read per turn because `/effort` changes it. */
  effort?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// System prompt
// ────────────────────────────────────────────────────────────────────────────

export interface MemoryPromptOptions {
  workspace: string;
  /**
   * The memory bundle. MUST return a reference that is stable WITHIN a session:
   * the bundle is embedded in the system prompt, which is byte 0 of the request
   * prefix. A session-boundary reload is fine — that advances the epoch.
   */
  getMemory: () => MemoryBundle;
  skillsBlock: string;
  /** Doubles as the prefix epoch: a new session is the only time the prompt may change. */
  getSessionId: () => string;
  /** Resolved response language ("en", "zh-CN", …). */
  getLanguage?: () => string | undefined;
}

/** The main agent's system prompt: workspace + memory + skills + language. */
export function createMemoryPrompt(opts: MemoryPromptOptions): SystemPromptProvider {
  return {
    epoch: () => opts.getSessionId(),
    system: () =>
      buildSystemPrompt(
        opts.workspace,
        opts.getMemory(),
        opts.getSessionId(),
        opts.skillsBlock,
        opts.getLanguage?.(),
      ),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// History
// ────────────────────────────────────────────────────────────────────────────

export interface SessionStoreOptions {
  /** Path of the session's `messages.jsonl`; re-read per write (`/resume` moves it). */
  getPath: () => string;
  /** The caller's canonical buffer — the CLI screen store, or `[]` for a sub-agent. */
  getMessages: () => MessageParam[];
  getCursor: () => PersistCursor;
  setCursor: (cursor: PersistCursor) => void;
}

/**
 * `messages.jsonl` as a history port. Writes are not serialized here — the agent
 * funnels every commit (loop boundaries and out-of-band flushes alike) through
 * one chain before it reaches this.
 */
export function createSessionStore(opts: SessionStoreOptions): {
  current: () => MessageParam[];
  commit: (messages: MessageParam[]) => Promise<void>;
} {
  return {
    current: () => opts.getMessages(),
    commit: async (messages) => {
      opts.setCursor(await persistMessages(opts.getPath(), messages, opts.getCursor()));
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tools / options
// ────────────────────────────────────────────────────────────────────────────

export interface ToolHostOptions {
  workspace: string;
  getTools: () => ToolDefinition[];
  dispatch: ToolExecutor;
  fileLedger: FileAccessLedger;
  askUser: AskUserFn;
  getSessionId: () => string;
  getSettings: () => AgentSettingsSlice;
}

export function createToolHost(opts: ToolHostOptions): ToolHost {
  return {
    list: () => opts.getTools(),
    execute: (use, ctx) => opts.dispatch(use, ctx),
    contextFor: () => {
      const settings = opts.getSettings();
      // No `signal` here — the agent injects the in-flight turn's controller.
      return {
        cwd: opts.workspace,
        fileLedger: opts.fileLedger,
        askUser: opts.askUser,
        sessionId: opts.getSessionId(),
        modelModalities: settings.modelModalities,
        effort: settings.effort,
      };
    },
  };
}

export function createOptions(
  getSettings: () => AgentSettingsSlice,
  getThinkingBudget: () => number,
): OptionsProvider {
  return {
    turn: (): TurnOptions => {
      const s = getSettings();
      return {
        maxTokens: s.maxTokens,
        maxTurns: s.maxTurns,
        maxTokensContinuations: s.maxTokensContinuations,
        toolConcurrency: s.toolConcurrency,
        thinkingBudgetTokens: getThinkingBudget(),
      };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Live-binding forwarders
// ────────────────────────────────────────────────────────────────────────────

/**
 * A stable `ModelClient` over a binding that changes (`/model`, or a sub-agent
 * resolving its own model per definition).
 */
export function forwardModel(getModel: () => ModelClient): ModelClient {
  return { call: (req) => getModel().call(req) };
}

/** A stable logger over a binding replaced at each session switch. */
export function forwardLogger(getLogger: () => RuntimeLogger): Logger {
  return {
    info: (obj, msg) => getLogger().info(obj, msg),
    warn: (obj, msg) => getLogger().warn(obj, msg),
    error: (obj, msg) => getLogger().error(obj, msg),
  };
}

/**
 * `transcript.jsonl` as an event sink. Adapts core's open `kind: string` to the
 * runtime's `TranscriptKind` union explicitly rather than leaning on TypeScript's
 * method-parameter bivariance; unknown kinds cannot occur — core only emits hook
 * point names plus `user_prompt` / `message_injected` / `error`, all of which the
 * union already carries.
 */
export function transcriptSink(getTranscript: () => Transcript): EventSink {
  return {
    append: (record) =>
      getTranscript().append({
        kind: record.kind as Parameters<Transcript["append"]>[0]["kind"],
        data: record.data,
      }),
    flush: () => getTranscript().flush(),
  };
}
