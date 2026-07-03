import { describe, expect, it, vi } from "vitest";
import type { AssistantTurn, MessageParam, ModelClient } from "@nova/core";
import {
  autoCompact,
  computeThreshold,
  estimateTokens,
  isCompactionMarker,
  shouldAutoCompact,
  sliceFromLastCompacted,
} from "./compact.js";

function boundary(summary: string): MessageParam {
  return { role: "user", content: `<compacted>\n[compacted]\n\n${summary}\n</compacted>` };
}

describe("isCompactionMarker / sliceFromLastCompacted", () => {
  it("detects a <compacted> user message and ignores everything else", () => {
    expect(isCompactionMarker(boundary("s"))).toBe(true);
    expect(isCompactionMarker({ role: "user", content: "hi" })).toBe(false);
    // assistant messages are never boundaries even if the text looks tagged
    expect(isCompactionMarker({ role: "assistant", content: "<compacted>x</compacted>" })).toBe(
      false,
    );
    // structured (block) content is never a boundary
    expect(
      isCompactionMarker({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a", content: "<compacted>" }],
      }),
    ).toBe(false);
  });

  it("returns the full array unchanged when there is no boundary", () => {
    const msgs: MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    expect(sliceFromLastCompacted(msgs)).toBe(msgs);
  });

  it("slices from the boundary inclusive", () => {
    const msgs: MessageParam[] = [
      { role: "user", content: "old-1" },
      { role: "assistant", content: [{ type: "text", text: "old-2" }] },
      boundary("summary A"),
      { role: "user", content: "new-1" },
    ];
    const view = sliceFromLastCompacted(msgs);
    expect(view).toHaveLength(2);
    expect(isCompactionMarker(view[0]!)).toBe(true);
    expect(view[1]?.content).toBe("new-1");
  });

  it("slices from the LAST boundary when several are present", () => {
    const msgs: MessageParam[] = [
      boundary("summary A"),
      { role: "user", content: "mid" },
      boundary("summary B"),
      { role: "user", content: "tail" },
    ];
    const view = sliceFromLastCompacted(msgs);
    expect(view).toHaveLength(2);
    expect(typeof view[0]?.content === "string" && view[0].content.includes("summary B")).toBe(
      true,
    );
    expect(view[1]?.content).toBe("tail");
  });
});

describe("shouldAutoCompact / computeThreshold", () => {
  it("throws when neither thresholdTokens nor contextWindowSize is provided", () => {
    expect(() => computeThreshold({})).toThrow(/thresholdTokens or contextWindowSize/);
  });

  it("uses thresholdTokens when set", () => {
    expect(computeThreshold({ thresholdTokens: 1234 })).toBe(1234);
  });

  it("computes 50% of contextWindowSize by default", () => {
    expect(computeThreshold({ contextWindowSize: 200_000 })).toBe(100_000);
  });

  it("respects contextWindowPercent override", () => {
    expect(
      computeThreshold({ contextWindowSize: 100_000, contextWindowPercent: 0.8 }),
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
    // Wrapped in a <compacted> tag so the TUI can skip its bubble.
    const content = r.messages[0]?.content;
    expect(typeof content === "string" && content.startsWith("<compacted>")).toBe(true);
    expect(content).toContain("</compacted>");
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
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
