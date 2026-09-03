import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  assembleAgent,
  emptyCursor,
  sliceFromLastCompacted,
  SUBAGENT_TOOL_NAME,
} from "@nova/agent";
import {
  blocksOf,
  extractText,
  staticPrompt,
  type AskUserFn,
  type MessageParam,
} from "@nova/core";
import { resolveMaxTokens, resolveModelModalities } from "@nova/base";
import type { CliContext } from "./context.js";
import {
  buildGoalEvalPrompt,
  parseVerdict,
  GOAL_EVAL_SYSTEM,
  type GoalState,
  type GoalVerdict,
} from "./goal.js";

/** Most recent assistant text in a message buffer, or "" when none. */
function lastAssistantText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = extractText(blocksOf(m)).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Judge whether `goal` is met by running a real, isolated evaluator agent — NOT
 * a bare model call — so it can use the full tool set to verify against the live
 * state (run tests, read files, fetch data). It reuses the host's dispatcher,
 * permission engine, sandbox, and file ledger, so any bash/write/edit it
 * attempts goes through the same confirmation prompts the main agent uses.
 *
 * The evaluator runs on its own fresh, throwaway message buffer (seeded only via
 * the prompt's conversation digest), the untracked `evalModel`, and a capped
 * turn budget. Its token spend is folded into the session totals. Throws if the
 * run is aborted, fails, or yields no final message — the caller treats that as
 * "stop", never as an implicit verdict.
 */
export async function evaluateGoalWithAgent(
  ctx: CliContext,
  goal: GoalState,
  signal?: AbortSignal,
): Promise<GoalVerdict> {
  const id = `goal-${randomUUID().slice(0, 8)}`;
  const evalModelName = ctx.settings.goal.evalModel ?? ctx.settings.model;
  // Full tool set minus createSubAgent — the evaluator verifies directly; it
  // must not spawn its own sub-agents.
  const tools = ctx.tools.definitions().filter((d) => d.name !== SUBAGENT_TOOL_NAME);

  // Throwaway message path: no event sink is wired (so nothing reaches a
  // transcript), and the messages file is a per-eval scratch file under the
  // session dir (overwritten each run), so the evaluator never pollutes the
  // canonical session history.
  let cursor = emptyCursor;

  const askUser: AskUserFn = (req) =>
    ctx.screen.askUser(req, signal ? { signal } : {});

  const evaluator = assembleAgent({
    workspace: ctx.workspace,
    getSessionId: () => id,
    getLogger: () => ctx.logger,
    // A fixed evaluator role prompt, not the session's memory bundle. Its epoch
    // is the eval id, so the prompt is constant for the run by construction.
    systemPrompt: staticPrompt(GOAL_EVAL_SYSTEM, id),
    getMessagesPath: () => join(ctx.session.dir, "goal-eval.messages.jsonl"),
    // No event sink: the evaluator is internal machinery and must not land in
    // the session transcript.
    getPersistCursor: () => cursor,
    setPersistCursor: (c) => {
      cursor = c;
    },
    getModel: () => ctx.buildModel(evalModelName, false),
    getThinkingLevel: () => "off",
    getSettings: () => ({
      maxTokens: resolveMaxTokens(ctx.settings, evalModelName),
      maxTurns: ctx.settings.goal.maxEvalTurns,
      maxTokensContinuations: ctx.settings.maxTokensContinuations,
      toolConcurrency: ctx.settings.toolConcurrency,
      modelModalities: resolveModelModalities(ctx.settings, evalModelName),
    }),
    getTools: () => tools,
    dispatch: ctx.dispatch,
    permission: ctx.permissionGate,
    compactor: ctx.compactor,
    fileLedger: ctx.fileLedger,
    askUser,
    getMessages: () => [],
  });

  // Evaluate against the model-facing view (post-<compacted> slice), matching
  // what the agent actually sees and keeping this bounded — the full retained
  // history stays on disk but must not blow this evaluator's context window.
  const prompt = buildGoalEvalPrompt(
    goal.condition,
    sliceFromLastCompacted(ctx.screen.getMessages()),
  );
  const result = await evaluator.runTurn(prompt, signal ? { signal } : {});

  // Fold the evaluator's spend into the session totals (it bills even on
  // abort/error), so /usage and the status line stay accurate.
  const u = result.totalUsage;
  if (u.inputTokens || u.outputTokens || u.cacheReadInputTokens || u.cacheCreationInputTokens) {
    ctx.screen.addUsage(u);
  }

  if (result.aborted) throw new Error("goal evaluation interrupted");
  if (!result.ok) throw new Error(result.error?.message ?? "goal evaluation failed");
  const text = lastAssistantText(result.messages);
  if (!text) throw new Error("goal evaluator produced no final message");
  return parseVerdict(text);
}
