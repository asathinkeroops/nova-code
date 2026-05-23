import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

const baseOpts = {
  system: "you are a test",
  tools: [echoTool],
  maxTokens: 1024,
  maxTurns: 10,
  toolContext: { cwd: "/tmp" },
  messages: [{ role: "user", content: "hi" }] as MessageParam[],
};

describe("agentLoop · stop_reason state machine", () => {
  it("returns on end_turn without invoking tools", async () => {
    const model = mockModel([
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    const exec = vi.fn(makeExecutor());
    const result = await agentLoop({ ...baseOpts, model, executeTool: exec });
    expect(result.stopReason).toBe("end_turn");
    expect(result.turns).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(result.totalUsage.inputTokens).toBe(10);
  });

  it("executes tool_use and feeds results back to the model", async () => {
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
    const result = await agentLoop({ ...baseOpts, model, executeTool: exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe("end_turn");
    // [user prompt, assistant(tool_use), user(tool_result), assistant(final text)]
    const toolResultMsg = result.messages[result.messages.length - 2];
    expect(toolResultMsg?.role).toBe("user");
    if (Array.isArray(toolResultMsg?.content)) {
      const tr = toolResultMsg.content[0];
      expect(tr?.type).toBe("tool_result");
      if (tr?.type === "tool_result") expect(tr.tool_use_id).toBe(useId);
    }
  });

  it("runs tools strictly serially and emits use/result in declaration order", async () => {
    const model = mockModel([
      {
        content: [
          { type: "tool_use", id: "a", name: "echo", input: { msg: "a" } },
          { type: "tool_use", id: "b", name: "echo", input: { msg: "b" } },
          { type: "tool_use", id: "c", name: "echo", input: { msg: "c" } },
        ],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
      },
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

    const seen: string[] = [];
    await agentLoop({
      ...baseOpts,
      model,
      executeTool: exec,
      observer: (e) => {
        if (e.kind === "tool_use") {
          seen.push(`use:${(e.payload as { id: string }).id}`);
        } else if (e.kind === "tool_result") {
          seen.push(`result:${(e.payload as { tool_use_id: string }).tool_use_id}`);
        }
      },
    });

    expect(maxActive).toBe(1);
    expect(seen).toEqual([
      "use:a",
      "result:a",
      "use:b",
      "result:b",
      "use:c",
      "result:c",
    ]);
  });

  it("isolates per-tool failure: one tool throwing still yields tool_results for the rest", async () => {
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

    const result = await agentLoop({ ...baseOpts, model, executeTool: exec });

    // user-message right after the assistant tool_use turn must carry one
    // tool_result per tool_use, in order.
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

  it("isolates observer errors so the tool_use ↔ tool_result pairing survives", async () => {
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
      ...baseOpts,
      model,
      executeTool: makeExecutor(),
      observer: (e) => {
        if (e.kind === "tool_use") throw new Error("observer exploded");
      },
    });

    const userMsg = result.messages[2];
    if (Array.isArray(userMsg?.content)) {
      const ids = userMsg.content.map((b) =>
        b.type === "tool_result" ? b.tool_use_id : null,
      );
      expect(ids).toEqual(["a", "b"]);
    }
  });

  it("synthesizes cancelled tool_results when the signal is pre-aborted", async () => {
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
      ...baseOpts,
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
    const model = mockModel([
      {
        content: [{ type: "text", text: "incomplete" }],
        stopReason: "max_tokens",
      },
    ]);
    await expect(
      agentLoop({ ...baseOpts, model, executeTool: makeExecutor() }),
    ).rejects.toBeInstanceOf(LoopTerminatedError);
  });

  it("throws LoopTerminatedError on refusal", async () => {
    const model = mockModel([
      {
        content: [{ type: "text", text: "I cannot help with that" }],
        stopReason: "refusal",
      },
    ]);
    await expect(
      agentLoop({ ...baseOpts, model, executeTool: makeExecutor() }),
    ).rejects.toBeInstanceOf(LoopTerminatedError);
  });

  it("continues on pause_turn", async () => {
    const model = mockModel([
      { content: [{ type: "text", text: "..." }], stopReason: "pause_turn" },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);
    const result = await agentLoop({
      ...baseOpts,
      model,
      executeTool: makeExecutor(),
    });
    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe("end_turn");
  });

  it("enforces maxTurns", async () => {
    const model: ModelClient = {
      async call(): Promise<AssistantTurn> {
        return {
          content: [{ type: "tool_use", id: `t-${Math.random()}`, name: "echo", input: { msg: "x" } }],
          stopReason: "tool_use",
        };
      },
    };
    await expect(
      agentLoop({
        ...baseOpts,
        model,
        executeTool: makeExecutor(),
        maxTurns: 3,
      }),
    ).rejects.toThrow(/maxTurns=3/);
  });

  it("calls compactor before each model.call and uses its return value", async () => {
    const seen: number[] = []; // messages.length each time model.call was hit
    const model: ModelClient = {
      call: async (req): Promise<AssistantTurn> => {
        seen.push(req.messages.length);
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };

    // Compactor that drops everything to a single placeholder message.
    const compactor = vi.fn(async (_msgs: MessageParam[]): Promise<MessageParam[]> => [
      { role: "user", content: "[compacted]" },
    ]);

    const events: Array<{ kind: string; payload: unknown }> = [];
    const messages: MessageParam[] = [
      { role: "user", content: "1" },
      { role: "user", content: "2" },
      { role: "user", content: "3" },
    ];
    await agentLoop({
      ...baseOpts,
      messages,
      model,
      executeTool: makeExecutor(),
      compactor,
      observer: (e) => {
        events.push({ kind: e.kind, payload: e.payload });
      },
    });
    expect(compactor).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([1]); // model saw the compacted (1-msg) history, not the 3-msg original
    const compactEvent = events.find((e) => e.kind === "compact");
    expect(compactEvent?.payload).toEqual({ from: 3, to: 1 });
  });

  it("does not emit a compact event when compactor returns the same array reference", async () => {
    const model = mockModel([{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]);
    const events: string[] = [];
    await agentLoop({
      ...baseOpts,
      model,
      executeTool: makeExecutor(),
      compactor: async (msgs) => msgs,
      observer: (e) => {
        events.push(e.kind);
      },
    });
    expect(events).not.toContain("compact");
  });

  it("calls interject at the end of each tool_use turn and appends its return value", async () => {
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
    const interject = vi.fn(async ({ turn, toolUses }: { turn: number; toolUses: ToolUseBlock[] }) => {
      seenTurns.push(turn);
      return [
        {
          role: "user",
          content: [{ type: "text", text: `nudge after ${toolUses[0]?.id ?? "?"}` }],
        },
      ] as MessageParam[];
    });
    const events: Array<{ kind: string; payload: unknown }> = [];
    const result = await agentLoop({
      ...baseOpts,
      model,
      executeTool: makeExecutor(),
      interject,
      observer: (e) => {
        events.push({ kind: e.kind, payload: e.payload });
      },
    });

    expect(interject).toHaveBeenCalledTimes(2);
    expect(seenTurns).toEqual([1, 2]);

    // Per turn the tail looks like: assistant(tool_use), user(tool_result), user(nudge).
    // After 2 tool turns + 1 end_turn assistant, history is:
    //   [user("hi"), assist(tool_a), user(result_a), user(nudge_a),
    //    assist(tool_b), user(result_b), user(nudge_b), assist("done")]
    expect(result.messages).toHaveLength(8);
    const nudgeA = result.messages[3];
    expect(nudgeA?.role).toBe("user");
    if (Array.isArray(nudgeA?.content)) {
      const block = nudgeA.content[0];
      if (block?.type === "text") expect(block.text).toBe("nudge after a");
    }

    const interjectEvents = events.filter((e) => e.kind === "interject");
    expect(interjectEvents).toHaveLength(2);
    expect(interjectEvents[0]?.payload).toEqual({ from: 3, to: 4 });
  });

  it("does not call interject on end_turn or pause_turn (no tool_use)", async () => {
    const model = mockModel([
      { content: [{ type: "text", text: "..." }], stopReason: "pause_turn" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    const interject = vi.fn(async () => []);
    await agentLoop({
      ...baseOpts,
      model,
      executeTool: makeExecutor(),
      interject,
    });
    expect(interject).not.toHaveBeenCalled();
  });

  it("does not emit an interject event when the hook returns undefined or []", async () => {
    const model = mockModel([
      {
        content: [{ type: "tool_use", id: "a", name: "echo", input: { msg: "x" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    const events: string[] = [];
    await agentLoop({
      ...baseOpts,
      model,
      executeTool: makeExecutor(),
      interject: async () => undefined,
      observer: (e) => {
        events.push(e.kind);
      },
    });
    expect(events).not.toContain("interject");
  });

  it("propagates exceptions thrown from interject and aborts the loop", async () => {
    const model = mockModel([
      {
        content: [{ type: "tool_use", id: "a", name: "echo", input: { msg: "x" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "should not reach" }], stopReason: "end_turn" },
    ]);
    await expect(
      agentLoop({
        ...baseOpts,
        model,
        executeTool: makeExecutor(),
        interject: async () => {
          throw new Error("interject boom");
        },
      }),
    ).rejects.toThrow(/interject boom/);
  });

  it("notifies observer for every event kind", async () => {
    const events: string[] = [];
    const model = mockModel([
      {
        content: [{ type: "tool_use", id: "a", name: "echo", input: { msg: "x" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    await agentLoop({
      ...baseOpts,
      model,
      executeTool: makeExecutor(),
      observer: (e) => {
        events.push(e.kind);
      },
    });
    expect(events).toContain("assistant");
    expect(events).toContain("tool_use");
    expect(events).toContain("tool_result");
    expect(events).toContain("user");
    expect(events).toContain("stop");
  });
});

describe("agentLoop · checkPermission gate", () => {
  const toolUseTurn: AssistantTurn = {
    content: [{ type: "tool_use", id: "a", name: "echo", input: { msg: "hi" } }],
    stopReason: "tool_use",
  };
  const endTurn: AssistantTurn = {
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
  };

  it("emits permission_start → permission_end → tool_result in order when granted", async () => {
    const exec = vi.fn(makeExecutor());
    const seen: string[] = [];
    await agentLoop({
      ...baseOpts,
      model: mockModel([toolUseTurn, endTurn]),
      executeTool: exec,
      checkPermission: async () => ({ granted: true }),
      observer: (e) => {
        if (
          e.kind === "tool_use" ||
          e.kind === "permission_start" ||
          e.kind === "permission_end" ||
          e.kind === "tool_result"
        ) {
          seen.push(e.kind);
        }
      },
    });
    expect(seen).toEqual(["tool_use", "permission_start", "permission_end", "tool_result"]);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("skips executeTool and yields a Permission denied tool_result when denied", async () => {
    const exec = vi.fn(makeExecutor());
    const events: Array<{ kind: string; payload: unknown }> = [];
    const result = await agentLoop({
      ...baseOpts,
      model: mockModel([toolUseTurn, endTurn]),
      executeTool: exec,
      checkPermission: async () => ({ granted: false, reason: "rule blocked" }),
      observer: (e) => {
        events.push({ kind: e.kind, payload: e.payload });
      },
    });

    expect(exec).not.toHaveBeenCalled();

    const endEvent = events.find((e) => e.kind === "permission_end");
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

  it("does not emit permission events when checkPermission is not configured", async () => {
    const events: string[] = [];
    await agentLoop({
      ...baseOpts,
      model: mockModel([toolUseTurn, endTurn]),
      executeTool: makeExecutor(),
      observer: (e) => {
        events.push(e.kind);
      },
    });
    expect(events).not.toContain("permission_start");
    expect(events).not.toContain("permission_end");
  });

  it("permission_end payload omits reason when granted with no reason supplied", async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    await agentLoop({
      ...baseOpts,
      model: mockModel([toolUseTurn, endTurn]),
      executeTool: makeExecutor(),
      checkPermission: async () => ({ granted: true }),
      observer: (e) => {
        events.push({ kind: e.kind, payload: e.payload });
      },
    });
    const endEvent = events.find((e) => e.kind === "permission_end");
    expect(endEvent?.payload).toEqual({ tool: "echo", toolUseId: "a", granted: true });
  });
});
