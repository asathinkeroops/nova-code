/**
 * One nova session, assembled: the main agent plus the `createSubAgent` tool it
 * spawns children with.
 *
 * `assembleAgent` builds ONE agent from a set of ports — it is the right entry
 * point for a one-off agent (the goal evaluator, a sub-agent). A session is the
 * larger unit a host actually runs: the two are built from overlapping bindings
 * and have to agree about them (the same memory bundle in both system prompts,
 * the same dispatcher, the same permission gate), and the rules connecting them
 * — which model a sub-agent runs on, which tools it must never see, where its
 * logs go — are agent policy, not host policy. They live here so a second host
 * gets them for free instead of re-deriving them.
 *
 * What stays with the host: anything shaped by its config schema or its UI.
 * `getSettings` slices, the tool registry, the permission gate, the compactor,
 * and every UI callback are still passed in.
 */

import type { Agent, Compactor, ModelClient, PermissionGate, ToolHandler } from "@nova/core";
import { join } from "node:path";
import { assembleAgent, type AssembleAgentOptions } from "./assemble.js";
import { sliceFromLastCompacted } from "./compact.js";
import type { AgentDefinition, AgentRegistry } from "./definitions.js";
import type { MemoryBundle } from "./memory.js";
import { createMemoryPrompt, type AgentSettingsSlice } from "./ports.js";
import { createSubAgentTool, type SubAgentDeps } from "./subagent.js";

/** Subdirectory of the session dir that per-sub-agent logs are written to. */
const SUBAGENT_LOG_DIR = "subagents";

/**
 * What both system prompts are built from. Read per use, not captured: a
 * session-boundary reload (`/clear`, `/resume`) has to reach the next prompt —
 * and only a session boundary may, since the bundle is byte 0 of the request
 * prefix (see the prefix-caching contract).
 */
export interface SessionMemoryOptions {
  getMemory: () => MemoryBundle;
  /** Skills index block embedded in both the main and the sub-agent prompt. */
  skillsBlock: string;
  /** Resolved response language ("en", "zh-CN", …). */
  getLanguage?: () => string | undefined;
}

export interface SubAgentSessionOptions {
  /** Set false to run the session without sub-agents at all. Default true. */
  enabled?: boolean;
  getAgentRegistry: () => AgentRegistry;
  /** maxTurns / maxTokens slice for the CHILD loop (usually distinct from the parent's). */
  getSettings: () => AgentSettingsSlice;

  /**
   * Builds a client for a resolved model id. Should return a NON-tracked client:
   * several sub-agents run concurrently and each reports its own running token
   * total, so a tracked one makes the host's live counter flicker between them.
   * Called once per distinct id — {@link assembleSession} caches by id.
   */
  buildModel: (id: string) => ModelClient;
  /**
   * The model id a sub-agent falls back to — the host's active main model, so
   * children follow a `/model` switch when nothing more specific is set.
   */
  getFallbackModelId: () => string;
  /**
   * Per-agent model ids the host ships as defaults, keyed by definition name.
   * Overridable one agent at a time by {@link getModelOverrides}.
   */
  defaultModels?: Record<string, string>;
  /** User's per-agent model overrides (keyed by definition name). Read live. */
  getModelOverrides?: () => Record<string, string> | undefined;

  /** Tool names no sub-agent may see. See `SubAgentDeps.excludeTools`. */
  excludeTools?: Iterable<string>;
  /** Session directory; per-sub-agent logs land in its `subagents/` subdir. */
  getSessionDir: () => string;

  onDetail?: SubAgentDeps["onDetail"];
  onUsage?: SubAgentDeps["onUsage"];
}

/**
 * Everything `assembleAgent` needs except the system prompt — which this builds
 * from {@link SessionMemoryOptions}, so the main agent and its children cannot
 * disagree about the memory bundle — plus the sub-agent block.
 */
export interface AssembleSessionOptions extends Omit<AssembleAgentOptions, "systemPrompt"> {
  memory: SessionMemoryOptions;
  /** Omit to run without sub-agents. */
  subagent?: SubAgentSessionOptions;
}

export interface AssembleSessionResult {
  agent: Agent;
  /**
   * The `createSubAgent` handler, for the host to register into the same tool
   * registry the parent reads. Undefined when sub-agents are off. Registering
   * it after assembly is safe: every dep reads its binding lazily.
   */
  subAgentTool?: ToolHandler;
}

/** Grants everything — matches `AssembleAgentOptions.permission`'s "omit to grant every tool call". */
const ALLOW_ALL: PermissionGate = { check: async () => ({ granted: true }) };

/** Never compacts — matches `AssembleAgentOptions.compactor`'s "omit to never compact". */
const NEVER_COMPACT: Compactor = {
  view: sliceFromLastCompacted,
  // Same reference back: that is how the loop reads "nothing happened".
  compact: async (messages) => messages,
};

/**
 * Resolve a sub-agent's model, most specific first: the user's per-name
 * override → the host's shipped default for that agent → the definition's own
 * `model` frontmatter → the active main model. The per-name override wins over
 * everything, so a built-in default is adjustable one agent at a time without
 * disturbing the others.
 *
 * Clients are cached by RESOLVED id, so agents landing on the same id share one.
 */
function subAgentModelResolver(
  opts: SubAgentSessionOptions,
): (def: AgentDefinition) => ModelClient {
  const cache = new Map<string, ModelClient>();
  return (def) => {
    const id =
      opts.getModelOverrides?.()?.[def.name] ??
      opts.defaultModels?.[def.name] ??
      def.model ??
      opts.getFallbackModelId();
    let model = cache.get(id);
    if (!model) {
      model = opts.buildModel(id);
      cache.set(id, model);
    }
    return model;
  };
}

export function assembleSession(opts: AssembleSessionOptions): AssembleSessionResult {
  const { memory, subagent, ...agentOpts } = opts;

  const agent = assembleAgent({
    ...agentOpts,
    systemPrompt: createMemoryPrompt({
      workspace: opts.workspace,
      getMemory: memory.getMemory,
      skillsBlock: memory.skillsBlock,
      // Doubles as the prefix epoch: the session id is the only thing whose
      // change licenses a new system prompt (see freezeSystemPrompt).
      getSessionId: opts.getSessionId,
      ...(memory.getLanguage ? { getLanguage: memory.getLanguage } : {}),
    }),
  });

  if (!subagent || subagent.enabled === false) return { agent };

  const subAgentTool = createSubAgentTool({
    workspace: opts.workspace,
    getMemory: memory.getMemory,
    skillsBlock: memory.skillsBlock,
    getAgentRegistry: subagent.getAgentRegistry,
    getModel: subAgentModelResolver(subagent),
    // The parent's own tool list, minus what a child may never see. Withholding
    // the definitions also arms the sub-agent's defense-in-depth permission
    // check, which denies anything outside the set it was given.
    getToolDefinitions: opts.getTools,
    ...(subagent.excludeTools ? { excludeTools: subagent.excludeTools } : {}),
    dispatch: opts.dispatch,
    // A child inherits the parent's gate and compaction terms; the defaults
    // match what omitting them means for the parent.
    permission: opts.permission ?? ALLOW_ALL,
    compactor: opts.compactor ?? NEVER_COMPACT,
    fileLedger: opts.fileLedger,
    askUser: opts.askUser,
    getLogger: opts.getLogger,
    getLogDir: () => join(subagent.getSessionDir(), SUBAGENT_LOG_DIR),
    getSettings: subagent.getSettings,
    // No transcript for the parent means none for its children either.
    noTranscript: opts.getTranscript === undefined,
    ...(subagent.onDetail ? { onDetail: subagent.onDetail } : {}),
    ...(subagent.onUsage ? { onUsage: subagent.onUsage } : {}),
  });

  return { agent, subAgentTool };
}
