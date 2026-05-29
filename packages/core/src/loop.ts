import { HookRegistry } from "./hooks.js";
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
  messages: MessageParam[];
  maxTokens: number;
  maxTurns: number;
  toolContext: ToolContext;
  /**
   * Single extension point for every cross-cutting concern: events
   * (`post_*`), policy (`pre_tool_use`, `pre_compact`, `pre_request`),
   * transformation (`post_tool_use`), injection (`pre_continue`).
   *
   * The loop never reads observers, compactors, permission gates, or
   * interject callbacks as separate options — register them all on this
   * registry. See `HookSpec` for the full set of points and their
   * advisory / blocking semantics.
   */
  hooks: HookRegistry;
  /**
   * When > 0, asks the model to allocate up to this many tokens to extended
   * thinking. Forwarded to every `model.call` in the loop unless a
   * `pre_request` hook overrides it.
   */
  thinkingBudgetTokens?: number;
  /**
   * Max number of tool executions to run concurrently within a single turn.
   * Granted tool calls beyond this cap queue and start as slots free up.
   * `undefined` or `<= 0` means unbounded (all granted calls run at once).
   * The product default (3) is supplied by the caller; core stays policy-free.
   */
  toolConcurrency?: number;
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
  const { hooks } = opts;
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

    // ── pre_compact (blocking) ────────────────────────────────────────────
    const compactDecision = await hooks.runBlocking("pre_compact", { messages });
    if (compactDecision && compactDecision.messages !== messages) {
      const before = messages.length;
      messages = compactDecision.messages;
      await hooks.runAdvisory("post_messages", { messages });
      await hooks.runAdvisory("post_compact", { before, after: messages.length });
    }

    // ── pre_request (blocking) → model.call → post_request (advisory) ─────
    const requestStartedAt = Date.now();
    const baseRequest = {
      system: opts.system,
      messages,
      tools: opts.tools,
      maxTokens: opts.maxTokens,
      ...(opts.thinkingBudgetTokens && opts.thinkingBudgetTokens > 0
        ? { thinkingBudgetTokens: opts.thinkingBudgetTokens }
        : {}),
    };
    const requestOverride = await hooks.runBlocking("pre_request", baseRequest);
    const finalRequest = { ...baseRequest, ...(requestOverride ?? {}) };

    // `messages` overrides are persisted to the canonical history so the next
    // iteration sees them; system/tools/maxTokens/thinkingBudgetTokens stay
    // per-request. Identity returns (same array reference) are treated as a
    // no-op so a hook can probe payload.messages without forcing a re-emit.
    if (requestOverride?.messages && requestOverride.messages !== messages) {
      messages = requestOverride.messages;
      await hooks.runAdvisory("post_messages", { messages });
    }

    let res: AssistantTurn;
    try {
      res = await opts.model.call({
        ...finalRequest,
        ...(opts.toolContext.signal ? { signal: opts.toolContext.signal } : {}),
      });
    } catch (err) {
      const endedAt = Date.now();
      await hooks.runAdvisory("post_request", {
        startedAt: requestStartedAt,
        endedAt,
        durationMs: endedAt - requestStartedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (res.usage) {
      totalUsage.inputTokens += res.usage.inputTokens;
      totalUsage.outputTokens += res.usage.outputTokens;
      totalUsage.cacheReadInputTokens += res.usage.cacheReadInputTokens ?? 0;
      totalUsage.cacheCreationInputTokens += res.usage.cacheCreationInputTokens ?? 0;
    }

    const endedAt = Date.now();
    await hooks.runAdvisory("post_request", {
      startedAt: requestStartedAt,
      endedAt,
      durationMs: endedAt - requestStartedAt,
      ...(res.usage ? { usage: res.usage } : {}),
      stopReason: res.stopReason,
    });

    const assistantMsg = assistantMessage(res.content);
    await hooks.runAdvisory("post_assistant", res);

    // Progressive reveal (see prior comment block, unchanged behavior).
    const nonToolUseContent = res.content.filter((b) => b.type !== "tool_use");
    const assistantMsgIdx = messages.length;
    messages = appendMessage(messages, assistantMessage(nonToolUseContent));
    await hooks.runAdvisory("post_messages", { messages });

    const decision = decide(res.stopReason);

    if (decision.kind === "error") {
      await hooks.runAdvisory("post_stop", {
        reason: decision.reason,
        message: decision.message,
      });
      throw new LoopTerminatedError(decision.reason, decision.message);
    }

    if (decision.kind === "return") {
      await hooks.runAdvisory("post_stop", { reason: decision.reason });
      return { messages, turns: turn, stopReason: decision.reason, totalUsage };
    }

    if (res.stopReason === "pause_turn") {
      continue;
    }

    const toolUses = extractToolUses(res.content);
    if (toolUses.length === 0) {
      await hooks.runAdvisory("post_stop", { reason: "end_turn" });
      return { messages, turns: turn, stopReason: "end_turn", totalUsage };
    }

    // Two-phase tool handling (see prior comment block, unchanged behavior).
    type Phase1Slot =
      | { use: ToolUseBlock; status: "cancelled" }
      | { use: ToolUseBlock; status: "denied"; reason: string }
      | { use: ToolUseBlock; status: "granted" };

    const slots: Phase1Slot[] = [];
    for (const use of toolUses) {
      const priorBlocks = blocksOf(messages[assistantMsgIdx]!);
      messages = [...messages];
      messages[assistantMsgIdx] = assistantMessage([...priorBlocks, use]);
      await hooks.runAdvisory("post_messages", { messages });

      if (opts.toolContext.signal?.aborted) {
        slots.push({ use, status: "cancelled" });
        continue;
      }

      await hooks.runAdvisory("pre_permission", { tool: use.name, toolUseId: use.id });
      const denied = await hooks.runBlocking("pre_tool_use", { use });
      await hooks.runAdvisory("post_permission", {
        tool: use.name,
        toolUseId: use.id,
        granted: !denied,
        ...(denied ? { reason: denied.reason } : {}),
      });

      if (denied) {
        slots.push({ use, status: "denied", reason: denied.reason });
      } else {
        slots.push({ use, status: "granted" });
      }
    }

    // Restore the assistant message to the model's exact block order.
    messages = [...messages];
    messages[assistantMsgIdx] = assistantMsg;
    await hooks.runAdvisory("post_messages", { messages });

    const results: (ToolResultBlock | undefined)[] = new Array(slots.length).fill(undefined);
    const userMsgIdx = messages.length;
    messages = appendMessage(messages, userToolResults([]));
    await hooks.runAdvisory("post_messages", { messages });

    const settlements = await settleWithConcurrency(
      slots,
      opts.toolConcurrency,
      async (slot, idx) => {
        let result: ToolResultBlock;
        if (slot.status === "cancelled") {
          result = errorToolResult(slot.use.id, "Tool execution cancelled");
        } else if (slot.status === "denied") {
          result = errorToolResult(slot.use.id, `Permission denied: ${slot.reason}`);
        } else if (opts.toolContext.signal?.aborted) {
          result = errorToolResult(slot.use.id, "Tool execution cancelled");
        } else {
          try {
            result = await opts.executeTool(slot.use, opts.toolContext);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result = errorToolResult(slot.use.id, `Tool execution failed: ${msg}`);
          }
        }

        // post_tool_use blocking: lets a hook replace the result before it's
        // folded into the message history.
        const override = await hooks.runBlocking("post_tool_use", { use: slot.use, result });
        if (override) result = override.result;

        results[idx] = result;
        const filled = results.filter((r): r is ToolResultBlock => r !== undefined);
        messages = [...messages];
        messages[userMsgIdx] = userToolResults(filled);
        await hooks.runAdvisory("post_messages", { messages });
      },
    );

    // Defense in depth: ensure every tool_use ends up paired with a result.
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
      await hooks.runAdvisory("post_messages", { messages });
    }

    const userMsg = messages[userMsgIdx]!;
    await hooks.runAdvisory("post_user_message", userMsg);

    // pre_continue blocking: register a hook to inject extra messages
    // between iterations (e.g. todo reminders).
    const injected = await hooks.runBlocking("pre_continue", { turn, toolUses });
    if (injected && injected.messages.length > 0) {
      messages = [...messages, ...injected.messages];
      await hooks.runAdvisory("post_messages", { messages });
    }
  }
}

function errorToolResult(toolUseId: string, content: string): ToolResultBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: true };
}

/**
 * Run `fn` over every item with at most `limit` in flight at once, returning
 * `PromiseSettledResult`s in INPUT order (like `Promise.allSettled`) so callers
 * can index settlements by slot. A pool of `limit` workers each pulls the next
 * unclaimed index until the queue drains. `limit` undefined / `<= 0` means
 * unbounded (one worker per item — identical to `Promise.allSettled`).
 */
async function settleWithConcurrency<T>(
  items: T[],
  limit: number | undefined,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const settlements: PromiseSettledResult<void>[] = new Array(items.length);
  if (items.length === 0) return settlements;

  const bounded = limit !== undefined && limit > 0;
  const workers = bounded ? Math.min(limit, items.length) : items.length;

  let next = 0;
  const worker = async (): Promise<void> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try {
        await fn(items[idx]!, idx);
        settlements[idx] = { status: "fulfilled", value: undefined };
      } catch (reason) {
        settlements[idx] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return settlements;
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
