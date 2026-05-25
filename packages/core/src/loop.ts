import {
  appendMessage,
  assistantMessage,
  blocksOf,
  extractToolUses,
  userToolResults,
} from "./messages.js";
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
  interject?: (ctx: { turn: number; toolUses: ToolUseBlock[] }) => Promise<MessageParam[] | void>;
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
      const before = messages.length;
      const compacted = await opts.compactor(messages);
      if (compacted !== messages) {
        messages = compacted;
        await safeObserve(opts.observer, {
          turn,
          kind: "messages_changed",
          payload: { messages },
        });
        await opts.observer?.({
          turn,
          kind: "compact_end",
          payload: { before, after: messages.length },
        });
      }
    }

    const requestStartedAt = Date.now();
    await opts.observer?.({
      turn,
      kind: "request_start",
      payload: { startedAt: requestStartedAt },
    });

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

    // report assistant message
    const assistantMsg = assistantMessage(res.content);
    await opts.observer?.({ turn, kind: "assistant", payload: assistantMsg });

    // Progressive reveal: commit the assistant message into `messages` without
    // its tool_use blocks for now. Each tool_use is spliced back in phase 1
    // immediately before its permission gate so the UI shows one card at a
    // time in lockstep with the popup, instead of painting all of them at
    // once and then prompting for the first.
    const nonToolUseContent = res.content.filter((b) => b.type !== "tool_use");
    const assistantMsgIdx = messages.length;
    messages = appendMessage(messages, assistantMessage(nonToolUseContent));
    await safeObserve(opts.observer, {
      turn,
      kind: "messages_changed",
      payload: { messages },
    });

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

    // Two-phase tool handling per turn:
    //
    //   Phase 1 (strictly serial): for each tool_use in declaration order,
    //   emit `tool_use`, then run `checkPermission` bracketed by
    //   `permission_start`/`permission_end`. Permission checks may prompt
    //   the user; they must never overlap.
    //
    //   Phase 2 (concurrent): every granted use is dispatched to
    //   `executeTool` via Promise.all. Denied / cancelled uses synthesize
    //   an error tool_result without invoking the executor. Each task
    //   commits its own result and emits `tool_result` + `messages_changed`
    //   as it completes (in completion order, not declaration order).
    //
    // Every tool_use always produces a tool_result so the pairing the API
    // requires on the next turn stays intact. The final user message
    // committed into `messages[userMsgIdx]` carries the tool_results in
    // declaration order (preserved by `Array.filter`'s index-order pass),
    // which is what the model sees on the next iteration.
    type Phase1Slot =
      | { use: ToolUseBlock; status: "cancelled" }
      | { use: ToolUseBlock; status: "denied"; reason: string }
      | { use: ToolUseBlock; status: "granted" };

    const slots: Phase1Slot[] = [];
    for (const use of toolUses) {
      // Reveal this tool_use to the UI right before we emit it: splice it into
      // the assistant message (which currently holds only non-tool_use blocks
      // plus any prior phase-1 tool_uses) and re-publish the snapshot. This
      // keeps visible tool_uses in lockstep with their permission gates so the
      // user sees one card appear, decides on it, then sees the next — rather
      // than seeing the full batch up front and only then being prompted.
      const priorBlocks = blocksOf(messages[assistantMsgIdx]!);
      messages = [...messages];
      messages[assistantMsgIdx] = assistantMessage([...priorBlocks, use]);
      await safeObserve(opts.observer, {
        turn,
        kind: "messages_changed",
        payload: { messages },
      });

      await safeObserve(opts.observer, { turn, kind: "tool_use", payload: use });

      if (opts.toolContext.signal?.aborted) {
        slots.push({ use, status: "cancelled" });
        continue;
      }

      if (!opts.checkPermission) {
        slots.push({ use, status: "granted" });
        continue;
      }

      await safeObserve(opts.observer, {
        turn,
        kind: "permission_start",
        payload: { tool: use.name, toolUseId: use.id },
      });
      const decision = await opts.checkPermission(use.name, use.input);
      await safeObserve(opts.observer, {
        turn,
        kind: "permission_end",
        payload: {
          tool: use.name,
          toolUseId: use.id,
          granted: decision.granted,
          ...(decision.reason ? { reason: decision.reason } : {}),
        },
      });

      if (decision.granted) {
        slots.push({ use, status: "granted" });
      } else {
        slots.push({ use, status: "denied", reason: decision.reason ?? "unknown" });
      }
    }

    // Phase 1 ended with tool_uses appended in declaration order (a side-
    // effect of the progressive reveal above), which may not match the
    // original interleaved order of `res.content` (e.g. when the model
    // emitted text or thinking blocks between tool_uses). Restore the
    // assistant message to the model's exact block order before phase 2
    // so the canonical history sent back on the next model.call matches
    // what the model produced. UI-wise this is a no-op for the cases that
    // matter (text is collapsed to the end of the assistant view, tool_use
    // cards keep rendering in the same relative order).
    messages = [...messages];
    messages[assistantMsgIdx] = assistantMsg;
    await safeObserve(opts.observer, {
      turn,
      kind: "messages_changed",
      payload: { messages },
    });

    // Reserve the user-message slot before phase 2 so concurrent tasks
    // can mutate it in place via index. Start with no results; each task
    // appends its own as it lands.
    const results: (ToolResultBlock | undefined)[] = new Array(slots.length).fill(undefined);
    const userMsgIdx = messages.length;
    messages = appendMessage(messages, userToolResults([]));
    await safeObserve(opts.observer, { turn, kind: "messages_changed", payload: { messages } });

    // Promise.allSettled (NOT Promise.all): one rejection must not abandon
    // the other in-flight tasks. The API on the next turn requires a
    // tool_result for every tool_use the assistant emitted; losing any one
    // breaks that pairing. Every observer call inside the task also runs
    // through safeObserve so an observer throw can't poison the task either.
    const settlements = await Promise.allSettled(
      slots.map(async (slot, idx) => {
        let result: ToolResultBlock;
        if (slot.status === "cancelled") {
          result = errorToolResult(slot.use.id, "Tool execution cancelled");
        } else if (slot.status === "denied") {
          result = errorToolResult(slot.use.id, `Permission denied: ${slot.reason}`);
        } else if (opts.toolContext.signal?.aborted) {
          // Signal flipped between phase 1 and phase 2 start — short-circuit
          // without invoking the executor.
          result = errorToolResult(slot.use.id, "Tool execution cancelled");
        } else {
          try {
            result = await opts.executeTool(slot.use, opts.toolContext);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result = errorToolResult(slot.use.id, `Tool execution failed: ${msg}`);
          }
        }

        results[idx] = result;
        // Project current completed results into the user-message slot in
        // declaration order — filter() preserves index order, so missing
        // entries (still-running tasks) just shift later results left
        // without reordering them.
        const filled = results.filter((r): r is ToolResultBlock => r !== undefined);
        messages = [...messages];
        messages[userMsgIdx] = userToolResults(filled);
        await safeObserve(opts.observer, { turn, kind: "tool_result", payload: result });
        await safeObserve(opts.observer, {
          turn,
          kind: "messages_changed",
          payload: { messages },
        });
      }),
    );

    // Defense in depth: with the task body fully safeObserve'd and
    // executeTool wrapped in try/catch, no slot should be left undefined.
    // If a future refactor introduces a throw outside those guards, fill in
    // a synthetic error result here so the tool_use ↔ tool_result pairing
    // the API requires on the next turn still holds.
    let needsFinalCommit = false;
    for (let i = 0; i < slots.length; i++) {
      if (results[i] === undefined) {
        needsFinalCommit = true;
        const slot = slots[i]!;
        const settled = settlements[i];
        const why =
          settled?.status === "rejected"
            ? settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason)
            : "missing result";
        results[i] = errorToolResult(slot.use.id, `Tool execution failed: ${why}`);
      }
    }
    if (needsFinalCommit) {
      messages = [...messages];
      messages[userMsgIdx] = userToolResults(results as ToolResultBlock[]);
      await safeObserve(opts.observer, {
        turn,
        kind: "messages_changed",
        payload: { messages },
      });
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
        await safeObserve(opts.observer, {
          turn,
          kind: "messages_changed",
          payload: { messages },
        });
      }
    }
  }
}

async function safeObserve(observer: LoopObserver | undefined, event: LoopEvent): Promise<void> {
  if (!observer) return;
  try {
    await observer(event);
  } catch {
    // Observer errors must not break the tool_use ↔ tool_result pairing or
    // any of the state-sync events that drive UI/transcript consumers.
    // Phase 2 in particular runs executors concurrently — a throw here
    // would reject only the surrounding task while siblings keep mutating
    // shared state, leaving the API pairing invariant in tatters.
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
