import { appendMessage, assistantMessage, extractToolUses, userToolResults } from "./messages.js";
import type { ModelClient } from "./model.js";
import { decide } from "./stop-reason.js";
import type {
  AssistantTurn,
  CheckPermissionFn,
  LoopEvent,
  LoopObserver,
  MessageParam,
  StopReason,
  ToolContext,
  ToolDefinition,
  ToolExecutor,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

export interface AgentLoopOptions {
  model: ModelClient;
  system: string;
  tools: ToolDefinition[];
  executeTool: ToolExecutor;
  /**
   * Optional permission gate. Invoked between `tool_use` and `executeTool`,
   * bracketed by `permission_start` / `permission_end` observer events. When
   * `granted: false`, the loop produces an is_error tool_result without
   * calling `executeTool`. When omitted, every tool runs unguarded.
   */
  checkPermission?: CheckPermissionFn;
  messages: MessageParam[];
  maxTokens: number;
  maxTurns: number;
  toolContext: ToolContext;
  observer?: LoopObserver;
  /**
   * Pre-call hook: invoked before every `model.call` so the caller can shrink
   * the message history (micro-compact, auto-summarize, etc.) without the loop
   * knowing about any compaction strategy. When the returned array is a
   * different reference than the input, the loop swaps it in and emits a
   * `messages_changed` event so observers can resync.
   */
  compactor?: (messages: MessageParam[]) => Promise<MessageParam[]>;
  /**
   * Post-turn hook: invoked at the END of each while-loop iteration when the
   * loop is about to continue (i.e. there was at least one tool_use this turn
   * and the stop_reason did not terminate the loop). Returns a list of
   * MessageParam to append to the conversation. Return undefined / [] for a
   * no-op. Exceptions bubble up and abort the loop.
   *
   * The loop emits an "interject" event with payload { from, to } iff the
   * returned array is non-empty.
   */
  interject?: (ctx: {
    turn: number;
    toolUses: ToolUseBlock[];
  }) => Promise<MessageParam[] | void>;
  /**
   * When > 0, asks the model to allocate up to this many tokens to extended
   * thinking. Forwarded to every `model.call` in the loop.
   */
  thinkingBudgetTokens?: number;
}

export interface LoopResult {
  messages: MessageParam[];
  turns: number;
  stopReason: StopReason;
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export async function agentLoop(opts: AgentLoopOptions): Promise<LoopResult> {
  let messages = [...opts.messages];
  let turn = 0;
  const totalUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (turn >= opts.maxTurns) {
      throw new Error(
        `agentLoop exceeded maxTurns=${opts.maxTurns} without an end_turn — possible runaway loop.`,
      );
    }
    turn++;

    if (opts.compactor) {
      const compacted = await opts.compactor(messages);
      if (compacted !== messages) {
        messages = compacted;
        await opts.observer?.({ turn, kind: "messages_changed", payload: { messages } });
      }
    }

    const requestStartedAt = Date.now();
    await opts.observer?.({ turn, kind: "request_start", payload: { startedAt: requestStartedAt } });

    let res: AssistantTurn;
    try {
      res = await opts.model.call({
        system: opts.system,
        messages,
        tools: opts.tools,
        maxTokens: opts.maxTokens,
        ...(opts.toolContext.signal ? { signal: opts.toolContext.signal } : {}),
        ...(opts.thinkingBudgetTokens && opts.thinkingBudgetTokens > 0
          ? { thinkingBudgetTokens: opts.thinkingBudgetTokens }
          : {}),
      });
    } catch (err) {
      await opts.observer?.({
        turn,
        kind: "request_end",
        payload: {
          startedAt: requestStartedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - requestStartedAt,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }

    if (res.usage) {
      totalUsage.inputTokens += res.usage.inputTokens;
      totalUsage.outputTokens += res.usage.outputTokens;
      totalUsage.cacheReadInputTokens += res.usage.cacheReadInputTokens ?? 0;
      totalUsage.cacheCreationInputTokens += res.usage.cacheCreationInputTokens ?? 0;
    }

    await opts.observer?.({
      turn,
      kind: "request_end",
      payload: {
        startedAt: requestStartedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - requestStartedAt,
        usage: res.usage,
        stopReason: res.stopReason,
      },
    });

    const assistantMsg = assistantMessage(res.content);
    messages = appendMessage(messages, assistantMsg);
    await opts.observer?.({ turn, kind: "assistant", payload: assistantMsg });
    await opts.observer?.({ turn, kind: "messages_changed", payload: { messages } });

    const decision = decide(res.stopReason);

    if (decision.kind === "error") {
      await opts.observer?.({
        turn,
        kind: "stop",
        payload: { reason: decision.reason, message: decision.message },
      });
      throw new LoopTerminatedError(decision.reason, decision.message);
    }

    if (decision.kind === "return") {
      await opts.observer?.({ turn, kind: "stop", payload: { reason: decision.reason } });
      return { messages, turns: turn, stopReason: decision.reason, totalUsage };
    }

    if (res.stopReason === "pause_turn") {
      continue;
    }

    const toolUses = extractToolUses(res.content);
    if (toolUses.length === 0) {
      await opts.observer?.({ turn, kind: "stop", payload: { reason: "end_turn" } });
      return { messages, turns: turn, stopReason: "end_turn", totalUsage };
    }

    // Per-tool serial: announce → permission_start → checkPermission →
    // permission_end → executeTool → tool_result. Every tool_use always
    // produces a tool_result so the pairing the API requires on the next
    // turn stays intact, even if a tool throws or an observer throws.
    //
    // Result commit is incremental: we append the user message before the
    // loop with no results, then replace it after each tool finishes. This
    // keeps `messages` as the single source of truth — observers see each
    // tool_result land via the very next `messages_changed`, with no need
    // for a parallel in-flight overlay. The intermediate state (assistant
    // has N tool_uses, user has < N tool_results) is never exposed: the
    // loop only calls `model.call` at the top of the next iteration, and
    // callers don't read `messages` until the loop returns.
    const results: ToolResultBlock[] = [];
    const userMsgIdx = messages.length;
    messages = appendMessage(messages, userToolResults(results));
    await opts.observer?.({ turn, kind: "messages_changed", payload: { messages } });

    for (const use of toolUses) {
      await safeObserve(opts.observer, { turn, kind: "tool_use", payload: use });

      let result: ToolResultBlock;
      if (opts.toolContext.signal?.aborted) {
        result = errorToolResult(use.id, "Tool execution cancelled");
      } else {
        let granted = true;
        let denyReason: string | undefined;
        if (opts.checkPermission) {
          await safeObserve(opts.observer, {
            turn,
            kind: "permission_start",
            payload: { tool: use.name, toolUseId: use.id },
          });
          const decision = await opts.checkPermission(use.name, use.input);
          granted = decision.granted;
          denyReason = decision.reason;
          await safeObserve(opts.observer, {
            turn,
            kind: "permission_end",
            payload: {
              tool: use.name,
              toolUseId: use.id,
              granted,
              ...(denyReason ? { reason: denyReason } : {}),
            },
          });
        }
        if (!granted) {
          result = errorToolResult(use.id, `Permission denied: ${denyReason ?? "unknown"}`);
        } else {
          try {
            result = await opts.executeTool(use, opts.toolContext);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result = errorToolResult(use.id, `Tool execution failed: ${msg}`);
          }
        }
      }

      results.push(result);
      messages = [...messages];
      messages[userMsgIdx] = userToolResults([...results]);
      await safeObserve(opts.observer, { turn, kind: "tool_result", payload: result });
      await opts.observer?.({ turn, kind: "messages_changed", payload: { messages } });
    }

    const userMsg = messages[userMsgIdx]!;
    await opts.observer?.({ turn, kind: "user", payload: userMsg });

    if (opts.interject) {
      const appended = await opts.interject({ turn, toolUses });
      if (appended && appended.length > 0) {
        const from = messages.length;
        messages = [...messages, ...appended];
        await opts.observer?.({
          turn,
          kind: "interject",
          payload: { from, to: messages.length },
        });
        await opts.observer?.({ turn, kind: "messages_changed", payload: { messages } });
      }
    }
  }
}

async function safeObserve(
  observer: LoopObserver | undefined,
  event: LoopEvent,
): Promise<void> {
  if (!observer) return;
  try {
    await observer(event);
  } catch {
    // Observer errors must not break the tool_use ↔ tool_result pairing.
  }
}

function errorToolResult(toolUseId: string, content: string): ToolResultBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: true };
}

export class LoopTerminatedError extends Error {
  constructor(
    public readonly reason: StopReason,
    message: string,
  ) {
    super(message);
    this.name = "LoopTerminatedError";
  }
}
