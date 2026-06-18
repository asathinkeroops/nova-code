import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createAgent, emptyCursor, type AgentSettingsSlice, type TurnResult } from "@nova/agent";
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
 * A single display-only detail entry streamed out of a running sub-agent so the
 * host UI can show what it's doing (the parent only receives the final report).
 * One of the sub-agent's reasoning steps, a tool it invoked, or its final
 * message. Kept terse — text is pre-truncated to a single short line, since the
 * host persists these and shows at most the latest few.
 */
export type SubAgentDetail =
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; summary: string }
  | { type: "final"; text: string };

/** How many trailing details to retain/emit (the UI shows the latest N). */
const MAX_DETAILS = 3;

/** Collapse to a single line and clip, so a detail is always one short row. */
function summarizeDetail(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Best-effort one-line summary of a tool_use's input for the detail row. */
function summarizeToolInput(input: Record<string, unknown>): string {
  // Prefer a salient string field (path/command/pattern/query/description),
  // falling back to a compact JSON dump. Keeps the row readable without
  // hard-coding every tool's schema.
  for (const key of ["command", "path", "pattern", "query", "description", "url"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return summarizeDetail(v, 80);
  }
  return summarizeDetail(JSON.stringify(input), 80);
}

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
  /**
   * Optional sink for live progress details (thinking / tool_use / final),
   * keyed by the parent `tool_use` id so the host can attach them to the right
   * tool-call card. Called repeatedly with the latest ≤3 entries as the
   * sub-agent runs; `done` is true on the final call (success, failure, or
   * abort) — the host updates the UI on every call and persists on `done`.
   * No-op when the parent tool_use id is unavailable.
   */
  onDetail?: (toolUseId: string, entries: SubAgentDetail[], done: boolean) => void;
  /**
   * Optional sink for the sub-agent's cumulative token usage, called once when
   * the run finishes (success, failure, OR abort) with the totals across every
   * model request the sub-agent made. The host folds these into the parent
   * session's usage counters so the status line / `/usage` / cost reflect
   * sub-agent spend too. Tokens are billed even on abort or error, so it is
   * called in every terminal branch whenever any were consumed.
   */
  onUsage?: (usage: TurnResult["totalUsage"]) => void;
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

      // Stream live progress (thinking / tool_use) out to the host, capped at
      // the latest MAX_DETAILS. Only wired when we know the parent tool_use id
      // (needed to key the details to the right UI card) and a sink is set.
      const toolUseId = ctx.toolUseId;
      const details: SubAgentDetail[] = [];
      const emit = (done: boolean): void => {
        if (!toolUseId || !deps.onDetail) return;
        deps.onDetail(toolUseId, details.slice(-MAX_DETAILS), done);
      };
      if (toolUseId && deps.onDetail) {
        agent.on("post_assistant", (turn) => {
          for (const b of turn.content) {
            if (b.type === "thinking" && b.thinking.trim()) {
              details.push({ type: "thinking", text: summarizeDetail(b.thinking) });
            }
          }
          emit(false);
        });
        agent.on("post_tool_use", ({ use }) => {
          details.push({
            type: "tool_use",
            name: use.name,
            summary: summarizeToolInput(use.input),
          });
          emit(false);
        });
      }

      const result = await agent.runTurn(
        input.prompt,
        ctx.signal ? { signal: ctx.signal } : {},
      );

      // Surface the sub-agent's token spend to the host before branching on the
      // outcome — tokens are billed even on abort/error, so report them in every
      // terminal path. Guard on a non-zero total so a no-request run is a no-op.
      const u = result.totalUsage;
      if (
        deps.onUsage &&
        (u.inputTokens || u.outputTokens || u.cacheReadInputTokens || u.cacheCreationInputTokens)
      ) {
        deps.onUsage(u);
      }

      if (result.aborted) {
        emit(true);
        return {
          output: `Sub-agent "${input.description}" was interrupted before finishing.`,
          isError: true,
        };
      }
      if (!result.ok) {
        emit(true);
        const reason = result.error?.message ?? "unknown error";
        return {
          output: `Sub-agent "${input.description}" failed: ${reason}`,
          isError: true,
        };
      }

      const finalText = lastAssistantText(result.messages);
      if (!finalText) {
        emit(true);
        return {
          output:
            `Sub-agent "${input.description}" finished without a textual final message ` +
            `(stopReason=${result.stopReason ?? "unknown"}, turns=${result.turns}).`,
        };
      }
      details.push({ type: "final", text: summarizeDetail(finalText) });
      emit(true);
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
