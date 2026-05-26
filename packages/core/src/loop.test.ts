import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HookRegistry, type HookPoint } from "./hooks.js";
import { agentLoop, LoopTerminatedError } from "./loop.js";
import type { ModelClient } from "./model.js";
import type {
  AssistantTurn,
  MessageParam,
  ToolDefinition,
  ToolExecutor,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

function mockModel(turns: AssistantTurn[]): ModelClient {
  let i = 0;
  return {
    async call() {
      const turn = turns[i];
      if (!turn) throw new Error(`Mock model exhausted at call ${i + 1}`);
      i++;
      return turn;
    },
  };
}

const echoTool: ToolDefinition = {
  name: "echo",
  description: "echo the input",
  inputSchema: z.object({ msg: z.string() }),
};

function makeExecutor(spy?: (use: ToolUseBlock) => void): ToolExecutor {
  return async (use): Promise<ToolResultBlock> => {
    spy?.(use);
    const input = use.input as { msg?: string };
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: `echo:${input.msg ?? ""}`,
    };
  };
}

/**
 * Build a `HookRegistry` plus a capture array that records every advisory
 * event in firing order. Saves boilerplate in tests that need to assert
 * event ordering or presence.
 */
function makeHooks(): {
  hooks: HookRegistry;
  events: { kind: HookPoint; payload: unknown }[];
} {
  const hooks = new HookRegistry();
  const events: { kind: HookPoint; payload: unknown }[] = [];
  const advisoryPoints: HookPoint[] = [
    "post_request",
    "post_assistant",
    "pre_permission",
    "post_permission",
    "post_user_message",
    "post_compact",
    "post_messages",
    "post_stop",
  ];
  for (const p of advisoryPoints) {
    hooks.on(p, (payload) => {
      events.push({ kind: p, payload });
    });
  }
  return { hooks, events };
}

function baseOpts(hooks: HookRegistry) {
  return {
    system: "you are a test",
    tools: [echoTool],
    maxTokens: 1024,
    maxTurns: 10,
    toolContext: { cwd: "/tmp" },
    messages: [{ role: "user", content: "hi" }] as MessageParam[],
    hooks,
  };
}

describe("agentLoop · stop_reason state machine", () => {
  it("returns on end_turn without invoking tools", async () => {
    const { hooks } = makeHooks();
    const model = mockModel([
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    const exec = vi.fn(makeExecutor());
    const result = await agentLoop({ ...baseOpts(hooks), model, executeTool: exec });
    expect(result.stopReason).toBe("end_turn");
    expect(result.turns).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(result.totalUsage.inputTokens).toBe(10);
  });

  it("executes tool_use and feeds results back to the model", async () => {
    const { hooks } = makeHooks();
    const useId = "tu_1";
    const model = mockModel([
      {
        content: [{ type: "tool_use", id: useId, name: "echo", input: { msg: "hi" } }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "all done" }],
        stopReason: "end_turn",
      },
    ]);
    const exec = vi.fn(makeExecutor());
    const result = await agentLoop({ ...baseOpts(hooks), model, executeTool: exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe("end_turn");
    const toolResultMsg = result.messages[result.messages.length - 2];
    expect(toolResultMsg?.role).toBe("user");
    if (Array.isArray(toolResultMsg?.content)) {
      const tr = toolResultMsg.content[0];
      expect(tr?.type).toBe("tool_result");
      if (tr?.type === "tool_result") expect(tr.tool_use_id).toBe(useId);
    }
  });

  it("invokes pre_permission per tool in declaration order then executes them concurrently", async () => {
    const { hooks } = makeHooks();
    const useOrder: string[] = [];
    const resultIds = new Set<string>();
    hooks.on("pre_permission", ({ toolUseId }) => {
      useOrder.push(toolUseId);
    });
    hooks.on("post_tool_use", ({ use }) => {
      resultIds.add(use.id);
    });

    const model = mockModel([
      {
        content: [
          { type: "tool_use", id: "a", name: "echo", input: { msg: "a" } },
          { type: "tool_use", id: "b", name: "echo", input: { msg: "b" } },
          { type: "tool_use", id: "c", name: "echo", input: { msg: "c" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);

    let active = 0;
    let maxActive = 0;
    const exec: ToolExecutor = async (use) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { type: "tool_result", tool_use_id: use.id, content: `done:${use.id}` };
    };

    const result = await agentLoop({ ...baseOpts(hooks), model, executeTool: exec });

    expect(useOrder).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(3);
    expect(resultIds).toEqual(new Set(["a", "b", "c"]));
    const userMsg = result.messages[2];
    if (Array.isArray(userMsg?.content)) {
      const ids = userMsg.content.map((b) =>
        b.type === "tool_result" ? b.tool_use_id : null,
      );
      expect(ids).toEqual(["a", "b", "c"]);
    }
  });

  it("reveals tool_use blocks one-at-a-time, paired with their permission gate", async () => {
    const log: { kind: string; visibleUses: string[] }[] = [];
    const snapshotVisible = (messages: MessageParam[]): string[] => {
      const ids: string[] = [];
      for (const m of messages) {
        if (m.role !== "assistant" || typeof m.content === "string") continue;
        for (const b of m.content) if (b.type === "tool_use") ids.push(b.id);
      }
      return ids;
    };
    let lastMessages: MessageParam[] = [];

    const hooks = new HookRegistry();
    hooks.on("post_messages", ({ messages }) => {
      lastMessages = messages;
    });
    hooks.on("pre_permission", ({ toolUseId }) => {
      log.push({ kind: `permission:${toolUseId}`, visibleUses: snapshotVisible(lastMessages) });
    });

    const model = mockModel([
      {
        content: [
          { type: "text", text: "running three tools" },
          { type: "tool_use", id: "a", name: "echo", input: { msg: "a" } },
          { type: "tool_use", id: "b", name: "echo", input: { msg: "b" } },
          { type: "tool_use", id: "c", name: "echo", input: { msg: "c" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);

    await agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor() });

    const permA = log.find((e) => e.kind === "permission:a");
    const permB = log.find((e) => e.kind === "permission:b");
    const permC = log.find((e) => e.kind === "permission:c");
    expect(permA?.visibleUses).toEqual(["a"]);
    expect(permB?.visibleUses).toEqual(["a", "b"]);
    expect(permC?.visibleUses).toEqual(["a", "b", "c"]);
  });

  it("preserves the model's original block order in the final assistant message even with interleaved tool_uses", async () => {
    const { hooks } = makeHooks();
    const interleaved = [
      { type: "text" as const, text: "first I will run a" },
      { type: "tool_use" as const, id: "a", name: "echo", input: { msg: "a" } },
      { type: "text" as const, text: "now b" },
      { type: "tool_use" as const, id: "b", name: "echo", input: { msg: "b" } },
      { type: "text" as const, text: "and finally c" },
      { type: "tool_use" as const, id: "c", name: "echo", input: { msg: "c" } },
    ];
    const model = mockModel([
      { content: interleaved, stopReason: "tool_use" },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);

    const result = await agentLoop({
      ...baseOpts(hooks),
      model,
      executeTool: makeExecutor(),
    });

    const assistantMsg = result.messages[1];
    expect(assistantMsg?.role).toBe("assistant");
    expect(assistantMsg?.content).toEqual(interleaved);
  });

  it("runs permission checks strictly serially even though execution is concurrent", async () => {
    let permActive = 0;
    let permMaxActive = 0;
    const permOrder: string[] = [];
    const hooks = new HookRegistry();
    hooks.on("pre_tool_use", async ({ use }) => {
      permActive++;
      permMaxActive = Math.max(permMaxActive, permActive);
      permOrder.push((use.input as { msg: string }).msg);
      await new Promise((r) => setTimeout(r, 3));
      permActive--;
      return undefined;
    });

    const model = mockModel([
      {
        content: [
          { type: "tool_use", id: "a", name: "echo", input: { msg: "a" } },
          { type: "tool_use", id: "b", name: "echo", input: { msg: "b" } },
          { type: "tool_use", id: "c", name: "echo", input: { msg: "c" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);

    let execActive = 0;
    let execMaxActive = 0;
    const exec: ToolExecutor = async (use) => {
      execActive++;
      execMaxActive = Math.max(execMaxActive, execActive);
      await new Promise((r) => setTimeout(r, 5));
      execActive--;
      return { type: "tool_result", tool_use_id: use.id, content: "ok" };
    };

    await agentLoop({ ...baseOpts(hooks), model, executeTool: exec });

    expect(permMaxActive).toBe(1);
    expect(permOrder).toEqual(["a", "b", "c"]);
    expect(execMaxActive).toBe(3);
  });

  it("isolates per-tool failure: one tool throwing still yields tool_results for the rest", async () => {
    const { hooks } = makeHooks();
    const model = mockModel([
      {
        content: [
          { type: "tool_use", id: "a", name: "echo", input: { msg: "a" } },
          { type: "tool_use", id: "b", name: "echo", input: { msg: "b" } },
          { type: "tool_use", id: "c", name: "echo", input: { msg: "c" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);

    const exec: ToolExecutor = async (use) => {
      if (use.id === "b") throw new Error("boom");
      return { type: "tool_result", tool_use_id: use.id, content: "ok" };
    };

    const result = await agentLoop({ ...baseOpts(hooks), model, executeTool: exec });

    const userMsg = result.messages[2];
    expect(userMsg?.role).toBe("user");
    if (Array.isArray(userMsg?.content)) {
      const ids = userMsg.content.map((b) =>
        b.type === "tool_result" ? b.tool_use_id : null,
      );
      expect(ids).toEqual(["a", "b", "c"]);
      const bResult = userMsg.content[1];
      if (bResult?.type === "tool_result") {
        expect(bResult.is_error).toBe(true);
        expect(String(bResult.content)).toContain("boom");
      }
    }
  });

  it("isolates advisory hook errors so the tool_use ↔ tool_result pairing survives", async () => {
    const hooks = new HookRegistry();
    // pre_permission is an advisory point — thrown errors must be swallowed
    // by HookRegistry without breaking the loop or any siblings.
    hooks.on("pre_permission", () => {
      throw new Error("hook exploded");
    });
    const model = mockModel([
      {
        content: [
          { type: "tool_use", id: "a", name: "echo", input: { msg: "a" } },
          { type: "tool_use", id: "b", name: "echo", input: { msg: "b" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);

    const result = await agentLoop({
      ...baseOpts(hooks),
      model,
      executeTool: makeExecutor(),
    });

    const userMsg = result.messages[2];
    if (Array.isArray(userMsg?.content)) {
      const ids = userMsg.content.map((b) =>
        b.type === "tool_result" ? b.tool_use_id : null,
      );
      expect(ids).toEqual(["a", "b"]);
    }
  });

  it("preserves every tool_result when one executor rejects and an advisory hook also throws", async () => {
    const hooks = new HookRegistry();
    hooks.on("post_messages", () => {
      throw new Error("hook exploded");
    });
    const model = mockModel([
      {
        content: [
          { type: "tool_use", id: "a", name: "echo", input: { msg: "a" } },
          { type: "tool_use", id: "b", name: "echo", input: { msg: "b" } },
          { type: "tool_use", id: "c", name: "echo", input: { msg: "c" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);

    const exec: ToolExecutor = async (use) => {
      if (use.id === "b") throw new Error("executor exploded");
      return { type: "tool_result", tool_use_id: use.id, content: `ok:${use.id}` };
    };

    const result = await agentLoop({ ...baseOpts(hooks), model, executeTool: exec });

    const userMsg = result.messages[2];
    expect(userMsg?.role).toBe("user");
    if (Array.isArray(userMsg?.content)) {
      const ids = userMsg.content.map((b) =>
        b.type === "tool_result" ? b.tool_use_id : null,
      );
      expect(ids).toEqual(["a", "b", "c"]);
      const bResult = userMsg.content[1];
      if (bResult?.type === "tool_result") {
        expect(bResult.is_error).toBe(true);
        expect(String(bResult.content)).toContain("executor exploded");
      }
    }
  });

  it("synthesizes cancelled tool_results when the signal is pre-aborted", async () => {
    const { hooks } = makeHooks();
    const model = mockModel([
      {
        content: [
          { type: "tool_use", id: "a", name: "echo", input: { msg: "a" } },
          { type: "tool_use", id: "b", name: "echo", input: { msg: "b" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);

    const ctrl = new AbortController();
    ctrl.abort();
    const exec = vi.fn(makeExecutor());

    const result = await agentLoop({
      ...baseOpts(hooks),
      toolContext: { cwd: "/tmp", signal: ctrl.signal },
      model,
      executeTool: exec,
    });

    expect(exec).not.toHaveBeenCalled();
    const userMsg = result.messages[2];
    if (Array.isArray(userMsg?.content)) {
      for (const block of userMsg.content) {
        if (block.type === "tool_result") {
          expect(block.is_error).toBe(true);
          expect(String(block.content)).toContain("cancelled");
        }
      }
    }
  });

  it("throws LoopTerminatedError on max_tokens", async () => {
    const { hooks } = makeHooks();
    const model = mockModel([
      { content: [{ type: "text", text: "incomplete" }], stopReason: "max_tokens" },
    ]);
    await expect(
      agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor() }),
    ).rejects.toBeInstanceOf(LoopTerminatedError);
  });

  it("throws LoopTerminatedError on refusal", async () => {
    const { hooks } = makeHooks();
    const model = mockModel([
      { content: [{ type: "text", text: "I cannot help with that" }], stopReason: "refusal" },
    ]);
    await expect(
      agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor() }),
    ).rejects.toBeInstanceOf(LoopTerminatedError);
  });

  it("continues on pause_turn", async () => {
    const { hooks } = makeHooks();
    const model = mockModel([
      { content: [{ type: "text", text: "..." }], stopReason: "pause_turn" },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);
    const result = await agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor() });
    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe("end_turn");
  });

  it("enforces maxTurns", async () => {
    const { hooks } = makeHooks();
    const model: ModelClient = {
      async call(): Promise<AssistantTurn> {
        return {
          content: [
            { type: "tool_use", id: `t-${Math.random()}`, name: "echo", input: { msg: "x" } },
          ],
          stopReason: "tool_use",
        };
      },
    };
    await expect(
      agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor(), maxTurns: 3 }),
    ).rejects.toThrow(/maxTurns=3/);
  });

  it("emits assistant / user / stop advisory events around a tool_use turn", async () => {
    const { hooks, events } = makeHooks();
    const model = mockModel([
      {
        content: [{ type: "tool_use", id: "a", name: "echo", input: { msg: "x" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    await agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor() });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("post_assistant");
    expect(kinds).toContain("post_user_message");
    expect(kinds).toContain("post_stop");
    expect(kinds).toContain("pre_permission");
    expect(kinds).toContain("post_permission");
  });
});

describe("agentLoop · pre_compact hook", () => {
  it("calls pre_compact before each model.call and uses its returned messages", async () => {
    const hooks = new HookRegistry();
    const seen: number[] = [];
    const model: ModelClient = {
      call: async (req): Promise<AssistantTurn> => {
        seen.push(req.messages.length);
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };

    const compactor = vi.fn(({ messages }: { messages: MessageParam[] }) => {
      // Always replace with a single placeholder.
      void messages;
      return { messages: [{ role: "user" as const, content: "[compacted]" }] };
    });
    hooks.on("pre_compact", compactor);

    await agentLoop({
      ...baseOpts(hooks),
      messages: [
        { role: "user", content: "1" },
        { role: "user", content: "2" },
        { role: "user", content: "3" },
      ],
      model,
      executeTool: makeExecutor(),
    });
    expect(compactor).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([1]);
  });

  it("fires post_compact with before/after counts when pre_compact swaps the array", async () => {
    const { hooks, events } = makeHooks();
    const model = mockModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);
    hooks.on("pre_compact", () => ({
      messages: [{ role: "user" as const, content: "[compacted]" }],
    }));
    await agentLoop({
      ...baseOpts(hooks),
      messages: [
        { role: "user", content: "1" },
        { role: "user", content: "2" },
        { role: "user", content: "3" },
      ],
      model,
      executeTool: makeExecutor(),
    });
    const compactEnds = events.filter((e) => e.kind === "post_compact");
    expect(compactEnds).toHaveLength(1);
    expect(compactEnds[0]?.payload).toEqual({ before: 3, after: 1 });
    const idxMsg = events.findIndex(
      (e) =>
        e.kind === "post_messages" &&
        (e.payload as { messages: MessageParam[] }).messages.length === 1,
    );
    const idxCompact = events.findIndex((e) => e.kind === "post_compact");
    expect(idxMsg).toBeGreaterThanOrEqual(0);
    expect(idxCompact).toBeGreaterThan(idxMsg);
  });

  it("does not emit post_messages from compaction when pre_compact returns undefined", async () => {
    const hooks = new HookRegistry();
    const model = mockModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);
    hooks.on("pre_compact", () => undefined);
    const seenLengths: number[] = [];
    hooks.on("post_messages", ({ messages }) => {
      seenLengths.push(messages.length);
    });
    await agentLoop({
      ...baseOpts(hooks),
      messages: [{ role: "user", content: "hi" }],
      model,
      executeTool: makeExecutor(),
    });
    // Only the post-assistant post_messages fires (length 2). No compaction
    // event because the hook returned undefined.
    expect(seenLengths).toEqual([2]);
  });
});

describe("agentLoop · pre_continue hook", () => {
  it("appends injected messages at the end of each tool_use turn", async () => {
    const hooks = new HookRegistry();
    const model = mockModel([
      {
        content: [{ type: "tool_use", id: "a", name: "echo", input: { msg: "x" } }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "tool_use", id: "b", name: "echo", input: { msg: "y" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    const seenTurns: number[] = [];
    const injector = vi.fn(
      ({ turn, toolUses }: { turn: number; toolUses: ToolUseBlock[] }) => {
        seenTurns.push(turn);
        return {
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: `nudge after ${toolUses[0]?.id ?? "?"}` },
              ],
            },
          ],
        };
      },
    );
    hooks.on("pre_continue", injector);

    const result = await agentLoop({
      ...baseOpts(hooks),
      model,
      executeTool: makeExecutor(),
    });

    expect(injector).toHaveBeenCalledTimes(2);
    expect(seenTurns).toEqual([1, 2]);
    expect(result.messages).toHaveLength(8);
    const nudgeA = result.messages[3];
    expect(nudgeA?.role).toBe("user");
    if (Array.isArray(nudgeA?.content)) {
      const block = nudgeA.content[0];
      if (block?.type === "text") expect(block.text).toBe("nudge after a");
    }
  });

  it("does not call pre_continue on end_turn or pause_turn", async () => {
    const hooks = new HookRegistry();
    const model = mockModel([
      { content: [{ type: "text", text: "..." }], stopReason: "pause_turn" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    const injector = vi.fn(() => ({ messages: [] }));
    hooks.on("pre_continue", injector);
    await agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor() });
    expect(injector).not.toHaveBeenCalled();
  });

  it("propagates exceptions thrown from pre_continue and aborts the loop", async () => {
    const hooks = new HookRegistry();
    const model = mockModel([
      {
        content: [{ type: "tool_use", id: "a", name: "echo", input: { msg: "x" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "should not reach" }], stopReason: "end_turn" },
    ]);
    hooks.on("pre_continue", () => {
      throw new Error("inject boom");
    });
    await expect(
      agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor() }),
    ).rejects.toThrow(/inject boom/);
  });
});

describe("agentLoop · pre_tool_use hook (permission gate)", () => {
  const toolUseTurn: AssistantTurn = {
    content: [{ type: "tool_use", id: "a", name: "echo", input: { msg: "hi" } }],
    stopReason: "tool_use",
  };
  const endTurn: AssistantTurn = {
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
  };

  it("fires pre_permission → post_permission → post_tool_use in order when allowed", async () => {
    const { hooks, events } = makeHooks();
    hooks.on("post_tool_use", () => undefined);
    const exec = vi.fn(makeExecutor());
    await agentLoop({
      ...baseOpts(hooks),
      model: mockModel([toolUseTurn, endTurn]),
      executeTool: exec,
    });
    const filtered = events
      .map((e) => e.kind)
      .filter((k) => k === "pre_permission" || k === "post_permission");
    expect(filtered).toEqual(["pre_permission", "post_permission"]);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("skips executeTool and yields a Permission denied tool_result when pre_tool_use returns {allow:false}", async () => {
    const { hooks, events } = makeHooks();
    hooks.on("pre_tool_use", () => ({ allow: false, reason: "rule blocked" }));
    const exec = vi.fn(makeExecutor());
    const result = await agentLoop({
      ...baseOpts(hooks),
      model: mockModel([toolUseTurn, endTurn]),
      executeTool: exec,
    });

    expect(exec).not.toHaveBeenCalled();
    const endEvent = events.find((e) => e.kind === "post_permission");
    expect(endEvent?.payload).toMatchObject({
      tool: "echo",
      toolUseId: "a",
      granted: false,
      reason: "rule blocked",
    });

    const userMsg = result.messages[2];
    if (Array.isArray(userMsg?.content)) {
      const block = userMsg.content[0];
      if (block?.type === "tool_result") {
        expect(block.is_error).toBe(true);
        expect(String(block.content)).toContain("Permission denied");
        expect(String(block.content)).toContain("rule blocked");
      }
    }
  });

  it("emits pre_permission / post_permission even when no pre_tool_use hook is registered (default allow)", async () => {
    const { hooks, events } = makeHooks();
    await agentLoop({
      ...baseOpts(hooks),
      model: mockModel([toolUseTurn, endTurn]),
      executeTool: makeExecutor(),
    });
    const endEvent = events.find((e) => e.kind === "post_permission");
    expect(endEvent?.payload).toEqual({ tool: "echo", toolUseId: "a", granted: true });
  });
});

describe("agentLoop · post_tool_use hook", () => {
  it("replaces the tool_result when post_tool_use returns {result}", async () => {
    const hooks = new HookRegistry();
    hooks.on("post_tool_use", ({ use }) => ({
      result: {
        type: "tool_result" as const,
        tool_use_id: use.id,
        content: "[REDACTED]",
      },
    }));

    const model = mockModel([
      {
        content: [{ type: "tool_use", id: "a", name: "echo", input: { msg: "secret" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);
    const result = await agentLoop({
      ...baseOpts(hooks),
      model,
      executeTool: makeExecutor(),
    });
    const userMsg = result.messages[2];
    if (Array.isArray(userMsg?.content)) {
      const block = userMsg.content[0];
      if (block?.type === "tool_result") expect(block.content).toBe("[REDACTED]");
    }
  });
});

describe("agentLoop · pre_request hook", () => {
  it("rewrites the system prompt before model.call sees it", async () => {
    const hooks = new HookRegistry();
    let saw: string | undefined;
    const model: ModelClient = {
      call: async (req): Promise<AssistantTurn> => {
        saw = req.system;
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };
    hooks.on("pre_request", ({ system }) => ({ system: `${system}\n[INJECTED]` }));
    await agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor() });
    expect(saw?.endsWith("[INJECTED]")).toBe(true);
  });

  it("persists a messages override into the canonical history", async () => {
    const hooks = new HookRegistry();
    const seen: MessageParam[][] = [];
    const model: ModelClient = {
      call: async (req): Promise<AssistantTurn> => {
        seen.push(req.messages);
        if (seen.length === 1) {
          return {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "echo",
                input: { msg: "first" },
              },
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };

    let injected = false;
    hooks.on("pre_request", ({ messages }) => {
      if (injected) return undefined;
      injected = true;
      return {
        messages: [
          ...messages,
          { role: "user", content: [{ type: "text", text: "[notification]" }] },
        ],
      };
    });

    const result = await agentLoop({ ...baseOpts(hooks), model, executeTool: makeExecutor() });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.length).toBe(2); // original user + injection
    expect(seen[1]?.length).toBeGreaterThan(seen[0]!.length); // injection still there + assistant + tool_result
    expect(JSON.stringify(seen[1])).toContain("[notification]");
    expect(JSON.stringify(result.messages)).toContain("[notification]");
  });
});
