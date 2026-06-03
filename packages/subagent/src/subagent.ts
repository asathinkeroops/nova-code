import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createAgent, emptyCursor, type AgentSettingsSlice } from "@nova/agent";
import type { MemoryBundle } from "@nova/context";
import {
  blocksOf,
  extractText,
  type AskUserFn,
  type FileAccessLedger,
  type MessageParam,
  type ModelClient,
  type PermissionResult,
  type ToolDefinition,
  type ToolExecutor,
  type ToolHandler,
} from "@nova/core";
import { Transcript } from "@nova/observability";
import type { Logger } from "@nova/runtime";
import type { AgentDefinition, AgentRegistry } from "./definitions.js";
import { buildSubAgentSystemPrompt } from "./system-prompt.js";

export const SUBAGENT_TOOL_NAME = "createSubAgent";

/**
 * Workspace-mutating tools. Withheld from read-only sub-agents both at the
 * tool-list level (the child never sees them) and at the permission level
 * (defense-in-depth, in case they reach dispatch another way).
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

const inputSchema = z
  .object({
    description: z
      .string()
      .min(1)
      .describe("Short (3-6 word) label for this sub-agent task, shown to the user."),
    prompt: z
      .string()
      .min(1)
      .describe(
        "The full task for the sub-agent. Make it self-contained: the sub-agent " +
          "shares NONE of this conversation. State the goal, relevant file paths, " +
          "and exactly what to report back.",
      ),
    // Validated as a free string here (the available set is dynamic — built-ins
    // plus user-defined agents); `run` resolves it against the live registry and
    // returns an error result listing the valid types on a miss.
    type: z
      .string()
      .min(1)
      .describe(
        "Which kind of sub-agent to spawn. Must be one of the available types " +
          "listed in this tool's description (see `Available types`).",
      ),
  })
  .strict();

const TOOL_DESCRIPTION_HEAD =
  "Spawn an autonomous sub-agent to complete a focused, self-contained task and " +
  "return its final report. The sub-agent runs with its own fresh context (it does " +
  "NOT see this conversation) and a tool set determined by its `type`. It cannot " +
  "spawn further sub-agents. Use it to parallelize independent work — emit multiple " +
  "createSubAgent calls in a single turn and they run concurrently — or to keep a " +
  "large, noisy investigation out of your own context. You receive ONLY the " +
  "sub-agent's final message, so make the prompt fully self-contained and tell it " +
  "what to report back. Don't use it for trivial one-step actions you can do directly.";

/** Render the tool description, enumerating the currently-registered types. */
function buildToolDescription(defs: AgentDefinition[]): string {
  const lines = defs.map((d) => `- "${d.name}": ${d.description}`).join("\n");
  return `${TOOL_DESCRIPTION_HEAD}\n\nAvailable types:\n${lines}`;
}

export interface SubAgentDeps {
  workspace: string;
  memory: MemoryBundle;
  /** Skills index block embedded in the sub-agent's system prompt. */
  skillsBlock: string;
  /**
   * Registry of available sub-agent definitions (built-ins + custom). Read
   * per-invocation so `/agents reload` is honored on the next spawn.
   */
  getAgentRegistry: () => AgentRegistry;
  /**
   * Resolve the model the sub-agent runs on. `modelId` is the definition's
   * optional model override; pass undefined for the default. Read
   * per-invocation so the active model is honored. The host is expected to
   * cache by id.
   */
  getModel: (modelId?: string) => ModelClient;
  /**
   * Parent tool definitions. The sub-agent gets these MINUS createSubAgent
   * (filtered here) to prevent unbounded recursion. Read per-invocation so the
   * set stays in sync with the parent registry.
   *
   * NOTE: the sub-agent reuses the parent's tool *implementations* via the
   * shared `dispatch`, so stateful tools (todo/task/longRunning) mutate the
   * parent session's stores. That's an intentional simplification; isolate
   * them later if sub-agents need their own scratch state.
   */
  getToolDefinitions: () => ToolDefinition[];
  /** Shared dispatcher — the sub-agent reuses the parent's tool implementations. */
  dispatch: ToolExecutor;
  checkPermission: (tool: string, input: unknown) => Promise<PermissionResult>;
  compactor: (messages: MessageParam[]) => Promise<MessageParam[]>;
  fileLedger: FileAccessLedger;
  askUser: AskUserFn;
  getLogger: () => Logger;
  /** Directory for per-sub-agent transcript/message logs (debug aid). */
  getLogDir: () => string;
  /** maxTurns / maxTokens / noTranscript slice for the sub-agent loop. */
  getSettings: () => AgentSettingsSlice;
}

export function createSubAgentTool(deps: SubAgentDeps): ToolHandler {
  return {
    definition: {
      name: SUBAGENT_TOOL_NAME,
      description: buildToolDescription(deps.getAgentRegistry().list()),
      inputSchema,
    },
    async run(rawInput, ctx) {
      const input = inputSchema.parse(rawInput);

      const registry = deps.getAgentRegistry();
      const def = registry.get(input.type);
      if (!def) {
        return {
          output:
            `Unknown sub-agent type "${input.type}". ` +
            `Available types: ${registry.names().join(", ")}.`,
          isError: true,
        };
      }

      const id = `sub-${randomUUID().slice(0, 8)}`;
      const logDir = deps.getLogDir();
      await mkdir(logDir, { recursive: true }).catch(() => {});

      // Sub-agent tool set = parent tools minus createSubAgent (no recursion).
      // `readOnly` drops the workspace-mutating tools; an `allowTools` list
      // (when present) intersects the set down further.
      const allow = def.allowTools ? new Set(def.allowTools) : null;
      const childTools = deps
        .getToolDefinitions()
        .filter(
          (d) =>
            d.name !== SUBAGENT_TOOL_NAME &&
            !(def.readOnly && MUTATING_TOOLS.has(d.name)) &&
            (!allow || allow.has(d.name)),
        );

      // Defense-in-depth: even though out-of-set tools are absent from
      // childTools, deny anything outside the resolved set at the permission
      // layer too (covers read-only mutating tools, non-allow-listed tools, and
      // createSubAgent in case any reach dispatch another way).
      const allowedNames = new Set(childTools.map((d) => d.name));
      const checkPermission: SubAgentDeps["checkPermission"] = async (tool, toolInput) =>
        allowedNames.has(tool)
          ? deps.checkPermission(tool, toolInput)
          : {
              granted: false,
              reason: `"${def.name}" sub-agent is not permitted to use ${tool}`,
            };

      // Per-definition loop-limit overrides on top of the host's settings slice.
      const getSettings: SubAgentDeps["getSettings"] = () => {
        const base = deps.getSettings();
        return {
          ...base,
          ...(def.maxTurns ? { maxTurns: def.maxTurns } : {}),
          ...(def.maxTokens ? { maxTokens: def.maxTokens } : {}),
        };
      };

      let cursor = emptyCursor;
      const transcript = new Transcript(join(logDir, `${id}.transcript.jsonl`));

      const agent = createAgent({
        workspace: deps.workspace,
        memory: deps.memory,
        skillsBlock: deps.skillsBlock,
        getSessionId: () => id,
        getMessagesPath: () => join(logDir, `${id}.messages.jsonl`),
        getTranscript: () => transcript,
        getLogger: deps.getLogger,
        getPersistCursor: () => cursor,
        setPersistCursor: (c) => {
          cursor = c;
        },
        getModel: () => deps.getModel(def.model),
        getThinkingBudget: () => 0,
        getSettings,
        getTools: () => childTools,
        dispatch: deps.dispatch,
        checkPermission,
        compactor: deps.compactor,
        fileLedger: deps.fileLedger,
        askUser: deps.askUser,
        getMessages: () => [],
        getSystemPrompt: () =>
          buildSubAgentSystemPrompt(deps.workspace, deps.memory, deps.skillsBlock, def),
      });

      const result = await agent.runTurn(
        input.prompt,
        ctx.signal ? { signal: ctx.signal } : {},
      );

      if (result.aborted) {
        return {
          output: `Sub-agent "${input.description}" was interrupted before finishing.`,
          isError: true,
        };
      }
      if (!result.ok) {
        const reason = result.error?.message ?? "unknown error";
        return {
          output: `Sub-agent "${input.description}" failed: ${reason}`,
          isError: true,
        };
      }

      const finalText = lastAssistantText(result.messages);
      if (!finalText) {
        return {
          output:
            `Sub-agent "${input.description}" finished without a textual final message ` +
            `(stopReason=${result.stopReason ?? "unknown"}, turns=${result.turns}).`,
        };
      }
      return { output: finalText };
    },
  };
}

function lastAssistantText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const text = extractText(blocksOf(m)).trim();
      if (text) return text;
    }
  }
  return "";
}
