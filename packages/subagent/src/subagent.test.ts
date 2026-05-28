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

const subagentDef: ToolDefinition = {
  name: SUBAGENT_TOOL_NAME,
  description: "spawn a sub-agent",
  inputSchema: z.object({ description: z.string(), prompt: z.string() }),
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
    memory: { system: "", sources: [] },
    skillsBlock: "",
    getModel: () => model,
    getToolDefinitions: () => [echoTool, subagentDef],
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
      { description: "do thing", prompt: "investigate X" },
      { cwd: tmp },
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe("final report");
  });

  it("hides createSubAgent from the child's tool list (no recursion)", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel([textTurn("ok")], seen);
    const tool = createSubAgentTool(makeDeps(model, tmp));

    await tool.run({ description: "x", prompt: "y" }, { cwd: tmp });

    expect(seen).toHaveLength(1);
    const names = seen[0]!.map((d) => d.name);
    expect(names).toContain("echo");
    expect(names).not.toContain(SUBAGENT_TOOL_NAME);
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

    const result = await tool.run({ description: "x", prompt: "echo hi" }, { cwd: tmp });

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe("echoed hi");
  });

  it("reports an error when the parent signal is already aborted", async () => {
    const seen: ToolDefinition[][] = [];
    const model = recordingModel([textTurn("should not reach")], seen);
    const tool = createSubAgentTool(makeDeps(model, tmp));
    const ac = new AbortController();
    ac.abort();

    const ctx: ToolContext = { cwd: tmp, signal: ac.signal };
    const result = await tool.run({ description: "x", prompt: "y" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/interrupted/i);
  });
});
