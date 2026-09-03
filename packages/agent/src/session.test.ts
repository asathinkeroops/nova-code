import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  AssistantTurn,
  ModelClient,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "@nova/core";
import { AgentRegistry, type AgentDefinition } from "./definitions.js";
import { emptyCursor } from "./persistence.js";
import { assembleSession, type AssembleSessionOptions } from "./session.js";
import { SUBAGENT_TOOL_NAME } from "./subagent.js";

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as ReturnType<NonNullable<AssembleSessionOptions["getLogger"]>>;

function toolDef(name: string): ToolDefinition {
  return { name, description: `does ${name}`, inputSchema: z.object({}) };
}

const TOOLS = [toolDef("read"), toolDef("enterPlanMode"), toolDef("exitPlanMode")];

function textTurn(text: string): AssistantTurn {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** A model that records every request it was handed, then replies once. */
function recordingModel(seen: { system: string; tools: ToolDefinition[] }[]): ModelClient {
  return {
    async call(req) {
      seen.push({ system: req.system, tools: req.tools });
      return textTurn("ok");
    },
  };
}

function makeOptions(
  model: ModelClient,
  dir: string,
  over: Partial<AssembleSessionOptions> = {},
): AssembleSessionOptions {
  let cursor = emptyCursor;
  return {
    workspace: "/ws",
    getSessionId: () => "sess-1",
    getLogger: () => silentLogger,
    memory: { getMemory: () => ({ system: "", sources: [] }) },
    getModel: () => model,
    getSettings: () => ({ maxTokens: 1024, maxTurns: 3 }),
    getThinkingLevel: () => "off",
    getTools: () => TOOLS,
    dispatch: async (use: ToolUseBlock): Promise<ToolResultBlock> => ({
      type: "tool_result",
      tool_use_id: use.id,
      content: "ok",
    }),
    fileLedger: { recordRead: () => {}, recordWrite: () => {}, get: () => undefined },
    askUser: async () => ({ answers: [] }),
    getMessages: () => [],
    getMessagesPath: () => join(dir, "messages.jsonl"),
    getPersistCursor: () => cursor,
    setPersistCursor: (c) => {
      cursor = c;
    },
    ...over,
  } as AssembleSessionOptions;
}

function subagentBlock(
  dir: string,
  over: Partial<NonNullable<AssembleSessionOptions["subagent"]>> = {},
): NonNullable<AssembleSessionOptions["subagent"]> {
  return {
    getAgentRegistry: () => new AgentRegistry(),
    getSettings: () => ({ maxTokens: 512, maxTurns: 2 }),
    buildModel: () => {
      throw new Error("buildModel not stubbed");
    },
    getFallbackModelId: () => "main-model",
    getSessionDir: () => dir,
    ...over,
  };
}

describe("assembleSession", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "session-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds the main prompt from the memory bundle it was given", async () => {
    const seen: { system: string; tools: ToolDefinition[] }[] = [];
    const model = recordingModel(seen);
    const { agent } = assembleSession(
      makeOptions(model, dir, {
        memory: {
          getMemory: () => ({ system: "<memory>PROJECT RULE</memory>", sources: [] }),
          getToolsGuidance: () => "<tool-guidance>\n- demo guidance\n</tool-guidance>",
          getLanguage: () => "zh-CN",
        },
      }),
    );

    await agent.runTurn("hi");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.system).toContain("PROJECT RULE");
    expect(seen[0]?.system).toContain("<tool-guidance>\n- demo guidance\n</tool-guidance>");
    expect(seen[0]?.system).toContain("zh-CN");
    // The session id is the prefix epoch the prompt is frozen against.
    expect(seen[0]?.system).toContain("sess-1");
  });

  it("returns no sub-agent tool when the block is absent or disabled", () => {
    const model = recordingModel([]);
    expect(assembleSession(makeOptions(model, dir)).subAgentTool).toBeUndefined();
    expect(
      assembleSession(makeOptions(model, dir, { subagent: subagentBlock(dir, { enabled: false }) }))
        .subAgentTool,
    ).toBeUndefined();
  });

  it("exposes createSubAgent for the host to register", () => {
    const { subAgentTool } = assembleSession(
      makeOptions(recordingModel([]), dir, { subagent: subagentBlock(dir) }),
    );
    expect(subAgentTool?.definition.name).toBe(SUBAGENT_TOOL_NAME);
    // The description enumerates the live registry so the parent knows the types.
    expect(subAgentTool?.definition.description).toContain("explore");
  });

  describe("sub-agent model precedence", () => {
    /** Spawns `type` and reports which model id the child was built on. */
    async function spawn(
      type: string,
      over: Partial<NonNullable<AssembleSessionOptions["subagent"]>>,
      registry = new AgentRegistry(),
    ): Promise<{ ids: string[]; builds: string[] }> {
      const builds: string[] = [];
      const ids: string[] = [];
      const { subAgentTool } = assembleSession(
        makeOptions(recordingModel([]), dir, {
          subagent: subagentBlock(dir, {
            getAgentRegistry: () => registry,
            buildModel: (id) => {
              builds.push(id);
              return {
                async call() {
                  ids.push(id);
                  return textTurn("done");
                },
              };
            },
            ...over,
          }),
        }),
      );
      await subAgentTool!.run({ description: "d", prompt: "p", type }, { cwd: dir });
      return { ids, builds };
    }

    it("falls back to the active main model when nothing is configured", async () => {
      const { ids } = await spawn("explore", {});
      expect(ids).toEqual(["main-model"]);
    });

    it("prefers the definition's own model over the fallback", async () => {
      const registry = new AgentRegistry();
      const custom: AgentDefinition = {
        name: "custom",
        description: "a custom agent",
        roleLine: "a custom worker",
        guidance: "",
        readOnly: true,
        model: "from-frontmatter",
        source: "user",
      };
      registry.addCustom([custom]);
      const { ids } = await spawn("custom", {}, registry);
      expect(ids).toEqual(["from-frontmatter"]);
    });

    it("prefers the host's shipped default over the definition's model", async () => {
      const registry = new AgentRegistry();
      registry.addCustom([
        {
          name: "custom",
          description: "a custom agent",
          roleLine: "a custom worker",
          guidance: "",
          readOnly: true,
          model: "from-frontmatter",
          source: "user",
        },
      ]);
      const { ids } = await spawn("custom", { defaultModels: { custom: "shipped" } }, registry);
      expect(ids).toEqual(["shipped"]);
    });

    it("lets the user's per-agent override win over everything", async () => {
      const { ids } = await spawn("explore", {
        defaultModels: { explore: "shipped" },
        getModelOverrides: () => ({ explore: "user-choice" }),
      });
      expect(ids).toEqual(["user-choice"]);
    });

    it("overrides one agent at a time, leaving the others on their default", async () => {
      const opts = {
        defaultModels: { explore: "shipped-explore", plan: "shipped-plan" },
        getModelOverrides: () => ({ explore: "user-choice" }),
      };
      expect((await spawn("explore", opts)).ids).toEqual(["user-choice"]);
      expect((await spawn("plan", opts)).ids).toEqual(["shipped-plan"]);
    });

    it("builds one client per resolved id and reuses it", async () => {
      const builds: string[] = [];
      const { subAgentTool } = assembleSession(
        makeOptions(recordingModel([]), dir, {
          subagent: subagentBlock(dir, {
            buildModel: (id) => {
              builds.push(id);
              return {
                async call() {
                  return textTurn("done");
                },
              };
            },
            // Both agents resolve to the same id, so they must share one client.
            defaultModels: { explore: "same", plan: "same" },
          }),
        }),
      );
      await subAgentTool!.run({ description: "d", prompt: "p", type: "explore" }, { cwd: dir });
      await subAgentTool!.run({ description: "d", prompt: "p", type: "plan" }, { cwd: dir });
      expect(builds).toEqual(["same"]);
    });
  });

  it("withholds excluded tools from the child", async () => {
    const childSaw: ToolDefinition[][] = [];
    const { subAgentTool } = assembleSession(
      makeOptions(recordingModel([]), dir, {
        subagent: subagentBlock(dir, {
          excludeTools: ["enterPlanMode", "exitPlanMode"],
          buildModel: () => ({
            async call(req) {
              childSaw.push(req.tools);
              return textTurn("done");
            },
          }),
        }),
      }),
    );

    await subAgentTool!.run({ description: "d", prompt: "p", type: "explore" }, { cwd: dir });

    const names = childSaw[0]?.map((d) => d.name) ?? [];
    expect(names).toContain("read");
    expect(names).not.toContain("enterPlanMode");
    expect(names).not.toContain("exitPlanMode");
  });

  it("writes sub-agent logs under the session's subagents/ directory", async () => {
    const { subAgentTool } = assembleSession(
      makeOptions(recordingModel([]), dir, {
        subagent: subagentBlock(dir, {
          buildModel: () => ({
            async call() {
              return textTurn("done");
            },
          }),
        }),
        // A transcript on the parent means the children write one too.
        getTranscript: () => ({ append: () => {}, flush: async () => {} }) as never,
      }),
    );

    await subAgentTool!.run({ description: "d", prompt: "p", type: "explore" }, { cwd: dir });

    const files = await readdir(join(dir, "subagents"));
    expect(files.some((f) => f.endsWith(".transcript.jsonl"))).toBe(true);
  });

  it("gives children no transcript when the parent has none", async () => {
    const { subAgentTool } = assembleSession(
      makeOptions(recordingModel([]), dir, {
        subagent: subagentBlock(dir, {
          buildModel: () => ({
            async call() {
              return textTurn("done");
            },
          }),
        }),
      }),
    );

    await subAgentTool!.run({ description: "d", prompt: "p", type: "explore" }, { cwd: dir });

    const files = await readdir(join(dir, "subagents"));
    expect(files.some((f) => f.endsWith(".transcript.jsonl"))).toBe(false);
  });
});
