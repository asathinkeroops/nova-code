import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantTurn,
  type MessageParam,
  type ModelClient,
  type ToolDefinition,
  type ToolExecutor,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@nova/core";
import { Transcript } from "@nova/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, type AgentDeps } from "./agent.js";
import type { HookPoint } from "@nova/core";
import { emptyCursor, loadMessages, type PersistCursor } from "./persistence.js";

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

function echoExecutor(): ToolExecutor {
  return async (use: ToolUseBlock): Promise<ToolResultBlock> => {
    const input = use.input as { msg?: string };
    return { type: "tool_result", tool_use_id: use.id, content: `echo:${input.msg ?? ""}` };
  };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as unknown as AgentDeps["getLogger"] extends () => infer L ? L : never;

function makeDeps(overrides: Partial<AgentDeps> & {
  model: ModelClient;
  messagesPath: string;
  transcriptPath: string;
}): AgentDeps {
  const messagesStore: { value: MessageParam[] } = { value: [] };
  const cursorStore: { value: PersistCursor } = { value: emptyCursor };
  const transcript = new Transcript(overrides.transcriptPath);

  return {
    workspace: "/tmp/ws",
    memory: { system: "", sources: [] },
    skillsBlock: "",
    getSessionId: () => "test-session",
    getMessagesPath: () => overrides.messagesPath,
    getTranscript: () => transcript,
    getLogger: () => silentLogger,
    getPersistCursor: () => cursorStore.value,
    setPersistCursor: (c) => {
      cursorStore.value = c;
    },
    getModel: () => overrides.model,
    getThinkingBudget: () => 0,
    getSettings: () => ({ maxTokens: 1024, maxTurns: 5, noTranscript: false }),
    getTools: () => [echoTool],
    dispatch: echoExecutor(),
    checkPermission: async () => ({ granted: true }),
    compactor: async (m) => m,
    fileLedger: {
      recordRead: () => {},
      recordWrite: () => {},
      get: () => undefined,
    },
    askUser: async () => ({ answers: [] }),
    getMessages: () => messagesStore.value,
    ...overrides,
  };
}

describe("createAgent.runTurn", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agent-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("fires turn_started before any loop event and turn_ended last", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const model = mockModel([
      {
        content: [{ type: "text", text: "hi" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));
    const order: HookPoint[] = [];
    // post_messages fires first (immediate sync of the appended user message),
    // pre_request fires before each model.call, post_request after, post_turn
    // last. Drop pre_user_prompt because it expects a blocking signature.
    const points: HookPoint[] = [
      "post_messages",
      "pre_request",
      "post_request",
      "post_turn",
    ];
    for (const p of points) {
      agent.on(p, () => {
        order.push(p);
      });
    }

    const result = await agent.runTurn("hello");

    expect(result.ok).toBe(true);
    expect(order[0]).toBe("post_messages");
    expect(order[order.length - 1]).toBe("post_turn");
    expect(order).toContain("pre_request");
    expect(order).toContain("post_request");
  });

  it("persists the final messages to disk and writes the user_prompt transcript line", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const model = mockModel([
      {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));

    const result = await agent.runTurn("hello");
    expect(result.ok).toBe(true);

    const persisted = await loadMessages(messagesPath);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.role).toBe("user");
    expect(persisted[1]?.role).toBe("assistant");

    const raw = await readFile(transcriptPath, "utf8");
    expect(raw).toContain('"kind":"user_prompt"');
  });

  it("currentSignal returns the in-flight signal and undefined when idle", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    let inFlightSignal: AbortSignal | undefined;
    const model: ModelClient = {
      async call() {
        inFlightSignal = agent.currentSignal();
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));

    expect(agent.currentSignal()).toBeUndefined();
    await agent.runTurn("hello");
    expect(inFlightSignal).toBeDefined();
    expect(inFlightSignal?.aborted).toBe(false);
    expect(agent.currentSignal()).toBeUndefined();
  });

  it("aborts the loop when the external signal fires and reports aborted=true", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const controller = new AbortController();
    const model: ModelClient = {
      async call(opts) {
        controller.abort(new Error("user esc"));
        await new Promise((resolve) => {
          if (opts.signal?.aborted) resolve(null);
          else opts.signal?.addEventListener("abort", () => resolve(null), { once: true });
        });
        throw new Error("interrupted by user");
      },
    };
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));

    const result = await agent.runTurn("hello", { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
  });
});

describe("createAgent · hooks", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agent-hook-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("advisory hooks swallow thrown errors and keep firing siblings", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const model = mockModel([
      {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));
    const survivor = vi.fn();
    agent.on("post_turn", () => {
      throw new Error("first hook is broken");
    });
    agent.on("post_turn", survivor);

    const result = await agent.runTurn("hello");
    expect(result.ok).toBe(true);
    expect(survivor).toHaveBeenCalledOnce();
  });

  it("returned unsubscribe function removes the hook", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const model = mockModel([
      {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));
    const fn = vi.fn();
    const off = agent.on("post_turn", fn);
    off();

    await agent.runTurn("hello");
    expect(fn).not.toHaveBeenCalled();
  });

  it("pre_user_prompt can rewrite the input and the loop sees the rewrite", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    let modelSawUserText: string | undefined;
    const model: ModelClient = {
      async call(opts) {
        const last = opts.messages[opts.messages.length - 1];
        // `userText` packs the prompt as a plain string `content`.
        if (typeof last?.content === "string") modelSawUserText = last.content;
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));
    agent.on("pre_user_prompt", ({ input }) => ({ input: `[rewritten] ${input}` }));

    const result = await agent.runTurn("hi");
    expect(result.ok).toBe(true);
    expect(modelSawUserText).toBe("[rewritten] hi");
  });

  it("pre_user_prompt can abort the turn before any transcript write", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const modelCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "unreachable" }],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const model: ModelClient = { call: modelCall };
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));
    agent.on("pre_user_prompt", () => ({ abort: true, reason: "blocked by policy" }));
    const turnEnded = vi.fn();
    agent.on("post_turn", turnEnded);

    const result = await agent.runTurn("hello");
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(modelCall).not.toHaveBeenCalled();
    expect(turnEnded).toHaveBeenCalledOnce();

    // No transcript line should have been written for an aborted-pre-prompt turn.
    let raw = "";
    try {
      raw = await readFile(transcriptPath, "utf8");
    } catch {
      // file may not exist yet — same as "empty transcript"
    }
    expect(raw).not.toContain("user_prompt");
  });

  it("pre_tool_use deny produces an is_error tool_result and lets the loop continue", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const useId = "tu_1";
    const model = mockModel([
      {
        content: [{ type: "tool_use", id: useId, name: "echo", input: { msg: "x" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [{ type: "text", text: "stopped" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const dispatch = vi.fn(echoExecutor());
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath, dispatch }));
    agent.on("pre_tool_use", ({ use }) => {
      if (use.name === "echo") return { allow: false, reason: "echo is blocked" };
    });

    const result = await agent.runTurn("call echo");
    expect(result.ok).toBe(true);
    // dispatch must not have been invoked: the deny short-circuits before
    // executeTool.
    expect(dispatch).not.toHaveBeenCalled();

    // The is_error tool_result is in the persisted history.
    const persisted = await loadMessages(messagesPath);
    const blocks = persisted.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    ) as Array<{ type: string; is_error?: boolean; content?: unknown }>;
    const result_block = blocks.find((b) => b.type === "tool_result");
    expect(result_block).toBeDefined();
    expect(result_block?.is_error).toBe(true);
  });

  it("pre_request can rewrite the system prompt before model.call sees it", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    let modelSawSystem: string | undefined;
    const model: ModelClient = {
      async call(opts) {
        modelSawSystem = opts.system;
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));
    agent.on("pre_request", ({ system }) => ({ system: `${system}\n[injected]` }));

    const result = await agent.runTurn("hi");
    expect(result.ok).toBe(true);
    expect(modelSawSystem?.endsWith("[injected]")).toBe(true);
  });

  it("post_tool_use replaces the result block and the model sees the replacement", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const useId = "tu_1";
    let modelSawSecondTurnResult: string | undefined;
    const model: ModelClient = {
      async call(opts) {
        if (opts.messages.length === 1) {
          return {
            content: [{ type: "tool_use", id: useId, name: "echo", input: { msg: "x" } }],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        // 2nd call: the loop has appended a user message holding the tool_result
        const last = opts.messages[opts.messages.length - 1];
        const blocks = Array.isArray(last?.content) ? last!.content : [];
        const r = blocks.find((b) => (b as { type?: string }).type === "tool_result") as
          | { content: unknown }
          | undefined;
        modelSawSecondTurnResult = typeof r?.content === "string" ? r.content : undefined;
        return {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));
    agent.on("post_tool_use", ({ result }) => ({
      result: { ...result, content: "[REDACTED]" },
    }));

    const result = await agent.runTurn("call echo");
    expect(result.ok).toBe(true);
    expect(modelSawSecondTurnResult).toBe("[REDACTED]");
  });

  it("post_compact does not fire when deps.compactor returns the same array reference", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const model = mockModel([
      {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    // No-op compactor: returns the same array reference, so the loop sees
    // "no change" and skips post_compact.
    const compactor = vi.fn(async (msgs: MessageParam[]) => msgs);
    const agent = createAgent(
      makeDeps({ model, messagesPath, transcriptPath, compactor }),
    );
    const compactEnd = vi.fn();
    agent.on("post_compact", compactEnd);

    const result = await agent.runTurn("hello");
    expect(result.ok).toBe(true);
    expect(compactor).toHaveBeenCalled();
    expect(compactEnd).not.toHaveBeenCalled();
  });

  it("blocking hooks short-circuit: first non-undefined decision wins", async () => {
    const messagesPath = join(tmp, "messages.jsonl");
    const transcriptPath = join(tmp, "transcript.jsonl");
    const model = mockModel([
      {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const agent = createAgent(makeDeps({ model, messagesPath, transcriptPath }));
    const secondHook = vi.fn();
    agent.on("pre_user_prompt", () => ({ abort: true, reason: "first" }));
    agent.on("pre_user_prompt", secondHook);

    const result = await agent.runTurn("hello");
    expect(result.aborted).toBe(true);
    expect(secondHook).not.toHaveBeenCalled();
  });
});
