import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantTurn,
  type ModelClient,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutor,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@nova/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentRegistry, type AgentDefinition } from "./definitions.js";
import { createSubAgentTool, SUBAGENT_TOOL_NAME, type SubAgentDeps } from "./subagent.js";

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as unknown as ReturnType<SubAgentDeps["getLogger"]>;

const echoTool: ToolDefinition = {
  name: "echo",
  description: "echo the input",
  inputSchema: z.object({ msg: z.string() }),
};

const writeDef: ToolDefinition = {
  name: "write",
  description: "write a file",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
};
const editDef: ToolDefinition = {
  name: "edit",
  description: "edit a file",
  inputSchema: z.object({ path: z.string() }),
};
const bashDef: ToolDefinition = {
  name: "bash",
  description: "run a command",
  inputSchema: z.object({ command: z.string() }),
};

const subagentDef: ToolDefinition = {
  name: SUBAGENT_TOOL_NAME,
  description: "spawn a sub-agent",
  inputSchema: z.object({ description: z.string(), prompt: z.string(), type: z.string() }),
};

function echoExecutor(): ToolExecutor {
  return async (use: ToolUseBlock): Promise<ToolResultBlock> => {
    const input = use.input as { msg?: string };
    return { type: "tool_result", tool_use_id: use.id, content: `echo:${input.msg ?? ""}` };
  };
}

/** Records the tool list each model.call saw, then replays scripted turns. */
function recordingModel(turns: AssistantTurn[], seen: ToolDefinition[][]): ModelClient {
  let i = 0;
  return {
    async call(req) {
      if (req.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      seen.push(req.tools);
      const turn = turns[i];
      if (!turn) throw new Error(`mock model exhausted at call ${i + 1}`);
      i++;
      return turn;
    },
  };
}

function textTurn(text: string): AssistantTurn {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function makeDeps(
  model: ModelClient,
  logDir: string,
  overrides: Partial<SubAgentDeps> = {},
): SubAgentDeps {
  return {
    workspace: "/tmp/ws",
    getMemory: () => ({ system: "", sources: [] }),
    skillsBlock: "",
    getAgentRegistry: () => new AgentRegistry(),
    getModel: () => model,
    getToolDefinitions: () => [echoTool, writeDef, editDef, bashDef, subagentDef],
    dispatch: echoExecutor(),
    checkPermission: async () => ({ granted: true }),
    compactor: async (m) => m,
    fileLedger: {
      recordRead: () => {},
      recordWrite: () => {},
      get: () => undefined,
    },
    askUser: async () => ({ answers: [] }),
    getLogger: () => silentLogger,
    getLogDir: () => logDir,
    getSettings: () => ({ maxTokens: 1024, maxTurns: 5, noTranscript: true }),
    ...overrides,
  };
}

describe("createSubAgentTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "subagent-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns the sub-agent's final assistant text", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel([textTurn("final report")], seen);
    const tool = createSubAgentTool(makeDeps(model, tmp));

    const result = await tool.run(
      { description: "do thing", prompt: "investigate X", type: "general-purpose" },
      { cwd: tmp },
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe("final report");
  });

  it("reports the sub-agent's token usage to onUsage", async () => {
    const seen: ToolDefinition[][] = [];
    // Two model calls (a tool_use turn then a final turn), each billing 1+1.
    const model = recordingModel(
      [
        {
          content: [{ type: "tool_use", id: "e1", name: "echo", input: { msg: "hi" } }],
          stopReason: "tool_use",
          usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 7 },
        },
        textTurn("final report"),
      ],
      seen,
    );
    const onUsage = vi.fn();
    const tool = createSubAgentTool(makeDeps(model, tmp, { onUsage }));

    await tool.run({ description: "x", prompt: "y", type: "general-purpose" }, { cwd: tmp });

    expect(onUsage).toHaveBeenCalledTimes(1);
    // Summed across both requests: input 3+1, output 2+1, cacheRead 7+0.
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 4,
      outputTokens: 3,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 0,
    });
  });

  it("hides createSubAgent from the child's tool list (no recursion)", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel([textTurn("ok")], seen);
    const tool = createSubAgentTool(makeDeps(model, tmp));

    await tool.run({ description: "x", prompt: "y", type: "general-purpose" }, { cwd: tmp });

    expect(seen).toHaveLength(1);
    const names = seen[0]!.map((d) => d.name);
    expect(names).toContain("echo");
    expect(names).not.toContain(SUBAGENT_TOOL_NAME);
  });

  it("general-purpose keeps write/edit/bash in the child's tool list", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel([textTurn("ok")], seen);
    const tool = createSubAgentTool(makeDeps(model, tmp));

    await tool.run({ description: "x", prompt: "y", type: "general-purpose" }, { cwd: tmp });

    const names = seen[0]!.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["write", "edit", "bash"]));
  });

  it.each(["explore", "plan"] as const)(
    "%s strips write/edit/bash but keeps read-only tools",
    async (type) => {
      const seen: ToolDefinition[][] = [];
      const model = recordingModel([textTurn("ok")], seen);
      const tool = createSubAgentTool(makeDeps(model, tmp));

      await tool.run({ description: "x", prompt: "y", type }, { cwd: tmp });

      const names = seen[0]!.map((d) => d.name);
      expect(names).toContain("echo");
      expect(names).not.toContain("write");
      expect(names).not.toContain("edit");
      expect(names).not.toContain("bash");
      expect(names).not.toContain(SUBAGENT_TOOL_NAME);
    },
  );

  it("read-only sub-agent denies a mutating tool at the permission layer", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel(
      [
        {
          content: [
            { type: "tool_use", id: "w1", name: "write", input: { path: "f", content: "c" } },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        textTurn("done"),
      ],
      seen,
    );
    const dispatch = vi.fn(echoExecutor());
    const checkPermission = vi.fn(async () => ({ granted: true }));
    const tool = createSubAgentTool(
      makeDeps(model, tmp, { dispatch, checkPermission }),
    );

    const result = await tool.run(
      { description: "x", prompt: "write a file", type: "explore" },
      { cwd: tmp },
    );

    expect(result.isError).toBeFalsy();
    // The wrapper denies `write` before it reaches the shared dispatch / parent check.
    expect(dispatch).not.toHaveBeenCalled();
    expect(checkPermission).not.toHaveBeenCalledWith("write", expect.anything());
  });

  it("runs the parent dispatcher for tool calls and returns the closing text", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel(
      [
        {
          content: [{ type: "tool_use", id: "t1", name: "echo", input: { msg: "hi" } }],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        textTurn("echoed hi"),
      ],
      seen,
    );
    const tool = createSubAgentTool(makeDeps(model, tmp));

    const result = await tool.run(
      { description: "x", prompt: "echo hi", type: "general-purpose" },
      { cwd: tmp },
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe("echoed hi");
  });

  it("returns an error result for an unknown sub-agent type", async () => {
    const model = recordingModel([textTurn("unreached")], []);
    const tool = createSubAgentTool(makeDeps(model, tmp));

    const result = await tool.run(
      { description: "x", prompt: "y", type: "does-not-exist" },
      { cwd: tmp },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unknown sub-agent type/i);
    expect(result.output).toContain("general-purpose");
  });

  it("intersects a custom agent's allowTools with the parent tool set", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel([textTurn("ok")], seen);
    const registry = new AgentRegistry();
    registry.addCustom([
      {
        name: "reader",
        description: "echo-only reader",
        roleLine: "a reader",
        guidance: "",
        readOnly: false,
        allowTools: ["echo"],
        source: "project",
      },
    ]);
    const tool = createSubAgentTool(
      makeDeps(model, tmp, { getAgentRegistry: () => registry }),
    );

    await tool.run({ description: "x", prompt: "y", type: "reader" }, { cwd: tmp });

    expect(seen[0]!.map((d) => d.name)).toEqual(["echo"]);
  });

  it("a custom readOnly agent strips write/edit/bash without an allow-list", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel([textTurn("ok")], seen);
    const registry = new AgentRegistry();
    registry.addCustom([
      {
        name: "auditor",
        description: "read-only auditor",
        roleLine: "an auditor",
        guidance: "",
        readOnly: true,
        source: "user",
      },
    ]);
    const tool = createSubAgentTool(
      makeDeps(model, tmp, { getAgentRegistry: () => registry }),
    );

    await tool.run({ description: "x", prompt: "y", type: "auditor" }, { cwd: tmp });

    const names = seen[0]!.map((d) => d.name);
    expect(names).toContain("echo");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("bash");
  });

  it("passes the full definition to getModel so the host can resolve per-agent", async () => {
    const model = recordingModel([textTurn("ok")], []);
    const getModel = vi.fn((_def: AgentDefinition) => model);
    const registry = new AgentRegistry();
    registry.addCustom([
      {
        name: "fancy",
        description: "uses a special model",
        roleLine: "fancy",
        guidance: "",
        readOnly: false,
        model: "special-model",
        source: "project",
      } satisfies AgentDefinition,
    ]);
    const tool = createSubAgentTool(
      makeDeps(model, tmp, { getAgentRegistry: () => registry, getModel }),
    );

    await tool.run({ description: "x", prompt: "y", type: "fancy" }, { cwd: tmp });

    expect(getModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fancy", model: "special-model" }),
    );
  });

  it("streams thinking/tool_use/final details to onDetail, keyed by tool_use id", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel(
      [
        {
          content: [
            { type: "thinking", thinking: "planning", signature: "sig" },
            { type: "tool_use", id: "t1", name: "echo", input: { msg: "hi" } },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        textTurn("final report"),
      ],
      seen,
    );
    const calls: Array<{ entries: unknown; done: boolean }> = [];
    const onDetail: SubAgentDeps["onDetail"] = (toolUseId, entries, done) => {
      expect(toolUseId).toBe("parent-use-1");
      calls.push({ entries: structuredClone(entries), done });
    };
    const tool = createSubAgentTool(makeDeps(model, tmp, { onDetail }));

    const result = await tool.run(
      { description: "x", prompt: "echo hi", type: "general-purpose" },
      { cwd: tmp, toolUseId: "parent-use-1" },
    );

    expect(result.output).toBe("final report");
    // Exactly one final (done) call carrying the latest ≤3 entries in order.
    const final = calls.at(-1)!;
    expect(final.done).toBe(true);
    expect(final.entries).toEqual([
      { type: "thinking", text: "planning" },
      // echo has no salient field (path/command/...), so the summary falls back
      // to a compact JSON dump of the input.
      { type: "tool_use", name: "echo", summary: '{"msg":"hi"}' },
      { type: "final", text: "final report" },
    ]);
    // Earlier calls were live (not done).
    expect(calls.slice(0, -1).every((c) => !c.done)).toBe(true);
  });

  it("does not call onDetail when the parent tool_use id is absent", async () => {
    const model = recordingModel([textTurn("ok")], []);
    const onDetail = vi.fn();
    const tool = createSubAgentTool(makeDeps(model, tmp, { onDetail }));

    await tool.run({ description: "x", prompt: "y", type: "general-purpose" }, { cwd: tmp });

    expect(onDetail).not.toHaveBeenCalled();
  });

  it("reports an error when the parent signal is already aborted", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel([textTurn("should not reach")], seen);
    const tool = createSubAgentTool(makeDeps(model, tmp));
    const ac = new AbortController();
    ac.abort();

    const ctx: ToolContext = { cwd: tmp, signal: ac.signal };
    const result = await tool.run(
      { description: "x", prompt: "y", type: "general-purpose" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/interrupted/i);
  });
});
