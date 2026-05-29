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
import { buildSubAgentSystemPrompt, type SubAgentType } from "./system-prompt.js";

export const SUBAGENT_TOOL_NAME = "createSubAgent";

/**
 * Workspace-mutating tools. Withheld from `explore` / `plan` sub-agents both at
 * the tool-list level (the child never sees them) and at the permission level
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
    type: z
      .enum(["explore", "plan", "general-purpose"])
      .describe(
        "Which kind of sub-agent to spawn:\n" +
          '- "explore": read-only retrieval. Locates code/files/usages and reports findings. Has NO write/edit/bash tools.\n' +
          '- "plan": read-only planning. Investigates a task and returns a step-by-step implementation plan. Has NO write/edit/bash tools.\n' +
          '- "general-purpose": full tool access (read, write, edit, bash, …) for tasks that must change files or run commands.',
      ),
  })
  .strict();

const TOOL_DESCRIPTION =
  "Spawn an autonomous sub-agent to complete a focused, self-contained task and " +
  "return its final report. The sub-agent runs with its own fresh context (it does " +
  "NOT see this conversation) and a tool set determined by `type` — `explore` and " +
  "`plan` are read-only (no write/edit/bash), `general-purpose` has your full tool " +
  "set. It cannot spawn further sub-agents. Use it to parallelize independent work — " +
  "emit multiple createSubAgent calls in a single turn and they run concurrently — or " +
  "to keep a large, noisy investigation out of your own context. You receive ONLY the " +
  "sub-agent's final message, so make the prompt fully self-contained and tell it " +
  "what to report back. Don't use it for trivial one-step actions you can do directly.";

export interface SubAgentDeps {
  workspace: string;
  memory: MemoryBundle;
  /** Skills index block embedded in the sub-agent's system prompt. */
  skillsBlock: string;
  /** Model the sub-agent runs on; read per-invocation so /model is honored. */
  getModel: () => ModelClient;
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
      description: TOOL_DESCRIPTION,
      inputSchema,
    },
    async run(rawInput, ctx) {
      const input = inputSchema.parse(rawInput);
      const id = `sub-${randomUUID().slice(0, 8)}`;
      const logDir = deps.getLogDir();
      await mkdir(logDir, { recursive: true }).catch(() => {});

      const readOnly = input.type !== "general-purpose";

      // Sub-agent tool set = parent tools minus createSubAgent (no recursion).
      // Read-only types (explore/plan) additionally drop workspace-mutating tools.
      const childTools = deps
        .getToolDefinitions()
        .filter(
          (d) =>
            d.name !== SUBAGENT_TOOL_NAME && !(readOnly && MUTATING_TOOLS.has(d.name)),
        );

      // Defense-in-depth: even though mutating tools are absent from childTools,
      // deny them at the permission layer for read-only sub-agents.
      const checkPermission: SubAgentDeps["checkPermission"] = readOnly
        ? async (tool, toolInput) =>
            MUTATING_TOOLS.has(tool)
              ? {
                  granted: false,
                  reason: `${input.type} sub-agent is read-only; ${tool} is not permitted`,
                }
              : deps.checkPermission(tool, toolInput)
        : deps.checkPermission;

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
        getModel: deps.getModel,
        getThinkingBudget: () => 0,
        getSettings: deps.getSettings,
        getTools: () => childTools,
        dispatch: deps.dispatch,
        checkPermission,
        compactor: deps.compactor,
        fileLedger: deps.fileLedger,
        askUser: deps.askUser,
        getMessages: () => [],
        getSystemPrompt: () =>
          buildSubAgentSystemPrompt(
            deps.workspace,
            deps.memory,
            deps.skillsBlock,
            input.type,
          ),
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
