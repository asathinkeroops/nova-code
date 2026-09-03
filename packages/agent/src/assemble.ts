import {
  createAgent,
  type Agent,
  type AgentContext,
  type AskUserFn,
  type Compactor,
  type FileAccessLedger,
  type MessageParam,
  type ModelClient,
  type PermissionGate,
  type SystemPromptProvider,
  type ThinkingLevel,
  type ToolDefinition,
  type ToolExecutor,
} from "@nova/core";
import type { Logger as RuntimeLogger, Transcript } from "@nova/base";
import type { PersistCursor } from "./persistence.js";
import {
  createOptions,
  createSessionStore,
  createToolHost,
  forwardLogger,
  forwardModel,
  transcriptSink,
  type AgentSettingsSlice,
} from "./ports.js";

/**
 * What it takes to assemble a nova agent: identity, live bindings, and the
 * capabilities the host provides. Everything that varies within a session is a
 * getter, and this file turns those getters into the stable port objects
 * `createAgent` wants (see the liveness rule in `@nova/core`'s `ports.ts`).
 *
 * The main agent and every sub-agent are the same `createAgent` call with a
 * different set of these — there is no second agent implementation.
 */
export interface AssembleAgentOptions {
  workspace: string;
  getSessionId: () => string;
  getLogger: () => RuntimeLogger;

  /** Produces the `system` prompt. `createMemoryPrompt` for the main agent, `staticPrompt` for sub-agents. */
  systemPrompt: SystemPromptProvider;

  getModel: () => ModelClient;
  getSettings: () => AgentSettingsSlice;
  getThinkingLevel: () => ThinkingLevel;

  getTools: () => ToolDefinition[];
  dispatch: ToolExecutor;
  fileLedger: FileAccessLedger;
  askUser: AskUserFn;

  /** The canonical pre-turn buffer (the CLI screen store; `[]` for a sub-agent). */
  getMessages: () => MessageParam[];
  getMessagesPath: () => string;
  getPersistCursor: () => PersistCursor;
  setPersistCursor: (cursor: PersistCursor) => void;

  /** Omit to record nothing — what `--no-transcript` means. */
  getTranscript?: () => Transcript;
  /** Omit to grant every tool call. */
  permission?: PermissionGate;
  /** Omit to never compact. */
  compactor?: Compactor;
}

export function assembleAgent(opts: AssembleAgentOptions): Agent {
  const ctx: AgentContext = {
    model: forwardModel(opts.getModel),
    systemPrompt: opts.systemPrompt,
    tools: createToolHost({
      workspace: opts.workspace,
      getTools: opts.getTools,
      dispatch: opts.dispatch,
      fileLedger: opts.fileLedger,
      askUser: opts.askUser,
      getSessionId: opts.getSessionId,
      getSettings: opts.getSettings,
    }),
    history: createSessionStore({
      getPath: opts.getMessagesPath,
      getMessages: opts.getMessages,
      getCursor: opts.getPersistCursor,
      setCursor: opts.setPersistCursor,
    }),
    options: createOptions(opts.getSettings, opts.getThinkingLevel),
    logger: forwardLogger(opts.getLogger),
    ...(opts.getTranscript ? { events: transcriptSink(opts.getTranscript) } : {}),
    ...(opts.permission ? { permission: opts.permission } : {}),
    ...(opts.compactor ? { compactor: opts.compactor } : {}),
  };
  return createAgent(ctx);
}
