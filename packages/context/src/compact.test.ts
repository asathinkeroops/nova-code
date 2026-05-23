import { describe, expect, it, vi } from "vitest";
import type { AssistantTurn, MessageParam, ModelClient, ToolResultBlock } from "@nova/core";
import {
  autoCompact,
  computeThreshold,
  estimateTokens,
  microCompact,
  shouldAutoCompact,
} from "./compact.js";

function toolUse(id: string, name: string): MessageParam {
  return { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] };
}

function toolResult(id: string, content: string): MessageParam {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] };
}

function firstResultContent(msg: MessageParam): string {
  if (typeof msg.content === "string") return msg.content;
  const block = msg.content[0];
  if (!block || block.type !== "tool_result") {
    throw new Error("expected tool_result block");
  }
  return (block as ToolResultBlock).content as string;
}

const LONG = "x".repeat(500);

describe("microCompact", () => {
  it("returns the input untouched when results <= keepRecent", () => {
    const messages: MessageParam[] = [
      toolUse("a", "bash"),
      toolResult("a", LONG),
      toolUse("b", "bash"),
      toolResult("b", LONG),
    ];
    const r = microCompact(messages, { keepRecent: 3 });
    expect(r.replaced).toBe(0);
    expect(r.messages).toBe(messages);
  });

  it("replaces old non-preserved tool_result content with a placeholder", () => {
    const messages: MessageParam[] = [
      toolUse("a", "bash"),
      toolResult("a", LONG),
      toolUse("b", "bash"),
      toolResult("b", LONG),
      toolUse("c", "bash"),
      toolResult("c", LONG),
      toolUse("d", "bash"),
      toolResult("d", LONG),
    ];
    const r = microCompact(messages, { keepRecent: 3 });
    expect(r.replaced).toBe(1);
    expect(firstResultContent(r.messages[1]!)).toBe("[Previous: used bash]");
    // last 3 untouched
    expect(firstResultContent(r.messages[3]!)).toBe(LONG);
    expect(firstResultContent(r.messages[5]!)).toBe(LONG);
    expect(firstResultContent(r.messages[7]!)).toBe(LONG);
    // original array is not mutated
    expect(firstResultContent(messages[1]!)).toBe(LONG);
  });

  it("preserves read-tool outputs by default", () => {
    const messages: MessageParam[] = [
      toolUse("a", "read"),
      toolResult("a", LONG),
      toolUse("b", "bash"),
      toolResult("b", LONG),
      toolUse("c", "bash"),
      toolResult("c", LONG),
      toolUse("d", "bash"),
      toolResult("d", LONG),
      toolUse("e", "bash"),
      toolResult("e", LONG),
    ];
    const r = microCompact(messages, { keepRecent: 3 });
    // 5 results, last 3 kept → 2 candidates. Of those, the read tool is
    // preserved and the bash one is replaced.
    expect(r.replaced).toBe(1);
    expect(firstResultContent(r.messages[1]!)).toBe(LONG);
    expect(firstResultContent(r.messages[3]!)).toBe("[Previous: used bash]");
  });

  it("skips content shorter than minContentChars", () => {
    const messages: MessageParam[] = [
      toolUse("a", "bash"),
      toolResult("a", "short"),
      toolUse("b", "bash"),
      toolResult("b", LONG),
      toolUse("c", "bash"),
      toolResult("c", LONG),
      toolUse("d", "bash"),
      toolResult("d", LONG),
    ];
    const r = microCompact(messages, { keepRecent: 3 });
    expect(r.replaced).toBe(0);
  });

  it("honors preserveTools override", () => {
    const messages: MessageParam[] = [
      toolUse("a", "grep"),
      toolResult("a", LONG),
      toolUse("b", "bash"),
      toolResult("b", LONG),
      toolUse("c", "bash"),
      toolResult("c", LONG),
      toolUse("d", "bash"),
      toolResult("d", LONG),
    ];
    const r = microCompact(messages, { keepRecent: 3, preserveTools: ["grep"] });
    expect(r.replaced).toBe(0);
    expect(firstResultContent(r.messages[1]!)).toBe(LONG);
  });
});

describe("shouldAutoCompact / computeThreshold", () => {
  it("throws when neither thresholdTokens nor contextWindowTokens is provided", () => {
    expect(() => computeThreshold({})).toThrow(/thresholdTokens or contextWindowTokens/);
  });

  it("uses thresholdTokens when set", () => {
    expect(computeThreshold({ thresholdTokens: 1234 })).toBe(1234);
  });

  it("computes 50% of contextWindowTokens by default", () => {
    expect(computeThreshold({ contextWindowTokens: 200_000 })).toBe(100_000);
  });

  it("respects contextWindowPercent override", () => {
    expect(
      computeThreshold({ contextWindowTokens: 100_000, contextWindowPercent: 0.8 }),
    ).toBe(80_000);
  });

  it("triggers when estimated tokens cross the threshold", () => {
    const long = "x".repeat(4 * 50_001);
    const opts = { thresholdTokens: 50_000 };
    expect(shouldAutoCompact([{ role: "user", content: long }], opts)).toBe(true);
    expect(shouldAutoCompact([{ role: "user", content: "hi" }], opts)).toBe(false);
  });

  it("estimateTokens grows with message size", () => {
    const short = estimateTokens([{ role: "user", content: "hi" }]);
    const long = estimateTokens([{ role: "user", content: "x".repeat(4000) }]);
    expect(long).toBeGreaterThan(short);
  });
});

describe("autoCompact", () => {
  function fakeModel(text: string, usage = { inputTokens: 100, outputTokens: 20 }): ModelClient {
    return {
      call: vi.fn(
        async (): Promise<AssistantTurn> => ({
          content: [{ type: "text", text }],
          stopReason: "end_turn",
          usage,
        }),
      ),
    };
  }

  it("compresses history into a single user message containing the summary", async () => {
    const model = fakeModel("SUMMARY OF WORK");
    const messages: MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const r = await autoCompact(messages, { model });
    expect(model.call).toHaveBeenCalledOnce();
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.role).toBe("user");
    expect(r.messages[0]?.content).toContain("SUMMARY OF WORK");
    expect(r.messages[0]?.content).toContain("[compacted]");
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it("calls saveTranscript and embeds the returned path in the marker", async () => {
    const save = vi.fn().mockResolvedValue("/tmp/snapshot.jsonl");
    const r = await autoCompact([{ role: "user", content: "x" }], {
      model: fakeModel("ok"),
      saveTranscript: save,
    });
    expect(save).toHaveBeenCalledOnce();
    expect(r.transcriptPath).toBe("/tmp/snapshot.jsonl");
    expect(r.messages[0]?.content).toContain("/tmp/snapshot.jsonl");
  });

  it("forwards focus hint into the summarizer prompt", async () => {
    const seen: Array<{ messages: MessageParam[] }> = [];
    const model: ModelClient = {
      call: async (req): Promise<AssistantTurn> => {
        seen.push({ messages: req.messages });
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };
    await autoCompact([{ role: "user", content: "hi" }], { model, focus: "current bug" });
    const userText = seen[0]?.messages[0]?.content as string;
    expect(userText).toContain("Focus on: current bug");
  });

  it("falls back to a default summary when the model returns no text", async () => {
    const model: ModelClient = {
      call: vi.fn(
        async (): Promise<AssistantTurn> => ({ content: [], stopReason: "end_turn" }),
      ),
    };
    const r = await autoCompact([{ role: "user", content: "hi" }], { model });
    expect(r.summary).toBe("No summary generated.");
    expect(r.messages[0]?.content).toContain("No summary generated.");
  });

  it("sends the full serialized history to the summarizer (no input truncation)", async () => {
    const seen: string[] = [];
    const model: ModelClient = {
      call: async (req): Promise<AssistantTurn> => {
        const userMsg = req.messages[0];
        if (userMsg && typeof userMsg.content === "string") seen.push(userMsg.content);
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };
    const huge: MessageParam[] = [{ role: "user", content: "y".repeat(200_000) }];
    await autoCompact(huge, { model });
    const prompt = seen[0] ?? "";
    expect(prompt).toContain("Summarize this conversation");
    expect(prompt).toContain("y".repeat(200_000));
  });
});
