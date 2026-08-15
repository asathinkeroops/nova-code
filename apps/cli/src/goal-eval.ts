import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgent,
  emptyCursor,
  sliceFromLastCompacted,
  SUBAGENT_TOOL_NAME,
} from "@nova/agent";
import { blocksOf, extractText, type AskUserFn, type MessageParam } from "@nova/core";
import { resolveMaxTokens, resolveModelModalities, Transcript } from "@nova/runtime";
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

  // Throwaway transcript/message paths: noTranscript keeps the transcript
  // unwritten, and the messages file is a per-eval scratch file under the
  // session dir (overwritten each run), so the evaluator never pollutes the
  // canonical session history.
  const transcript = new Transcript(join(ctx.session.dir, "goal-eval.transcript.jsonl"));
  let cursor = emptyCursor;

  const askUser: AskUserFn = (req) =>
    ctx.screen.askUser(req, signal ? { signal } : {});

  const evaluator = createAgent({
    workspace: ctx.workspace,
    getMemory: () => ctx.memory,
    skillsBlock: ctx.skillsBlock,
    getSessionId: () => id,
    getMessagesPath: () => join(ctx.session.dir, "goal-eval.messages.jsonl"),
    getTranscript: () => transcript,
    getLogger: () => ctx.logger,
    getPersistCursor: () => cursor,
    setPersistCursor: (c) => {
      cursor = c;
    },
    getModel: () => ctx.buildModel(evalModelName, false),
    getThinkingBudget: () => 0,
    getSettings: () => ({
      maxTokens: resolveMaxTokens(ctx.settings, evalModelName),
      maxTurns: ctx.settings.goal.maxEvalTurns,
      maxTokensContinuations: ctx.settings.maxTokensContinuations,
      noTranscript: true,
      toolConcurrency: ctx.settings.toolConcurrency,
      modelModalities: resolveModelModalities(ctx.settings, evalModelName),
    }),
    getTools: () => tools,
    dispatch: ctx.dispatch,
    checkPermission: ctx.checkPermission,
    compactor: ctx.compactor,
    fileLedger: ctx.fileLedger,
    askUser,
    getMessages: () => [],
    getSystemPrompt: () => GOAL_EVAL_SYSTEM,
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
