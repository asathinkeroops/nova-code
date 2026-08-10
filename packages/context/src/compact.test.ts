import { describe, expect, it, vi } from "vitest";
import { markSynthetic, type AssistantTurn, type MessageParam, type ModelClient } from "@nova/core";
import {
  autoCompact,
  computeThreshold,
  estimateTokens,
  isCompactionMarker,
  shouldAutoCompact,
  sliceFromLastCompacted,
} from "./compact.js";

function boundary(summary: string): MessageParam {
  return markSynthetic(
    { role: "user", content: `<compacted>\n[compacted]\n\n${summary}\n</compacted>` },
    "compacted",
  );
}

describe("isCompactionMarker / sliceFromLastCompacted", () => {
  it("detects a compacted-tagged user message and ignores everything else", () => {
    expect(isCompactionMarker(boundary("s"))).toBe(true);
    expect(isCompactionMarker({ role: "user", content: "hi" })).toBe(false);
    // A user who TYPES the tag verbatim is not a boundary — detection keys off
    // meta.kind, never the forgeable string, so it can't truncate model context.
    expect(isCompactionMarker({ role: "user", content: "<compacted>not real</compacted>" })).toBe(
      false,
    );
    // Other synthetic kinds are not compaction boundaries.
    expect(
      isCompactionMarker(markSynthetic({ role: "user", content: "hi" }, "todo-reminder")),
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
    expect(computeThreshold({ contextWindowSize: 100_000, contextWindowPercent: 0.8 })).toBe(
      80_000,
    );
  });

  it("triggers when estimated tokens cross the threshold", () => {
    const long = "x".repeat(4 * 50_001);
    const opts = { thresholdTokens: 50_000 };
    expect(shouldAutoCompact([{ role: "user", content: long }], opts)).toBe(true);
    expect(shouldAutoCompact([{ role: "user", content: "hi" }], opts)).toBe(false);
  });

  // The system prompt and tool schemas ride on every request, so they fill the
  // window exactly as the messages do. Leaving them out of the trigger is what
  // let a 90% threshold fire only once the real prompt was already over 100% on
  // a small context window.
  it("counts fixed overhead against the threshold", () => {
    const messages = [{ role: "user" as const, content: "x".repeat(4 * 30_000) }];
    const opts = { thresholdTokens: 50_000 };
    expect(shouldAutoCompact(messages, opts)).toBe(false);
    expect(shouldAutoCompact(messages, { ...opts, overheadTokens: 25_000 })).toBe(true);
  });

  it("treats absent overhead as zero", () => {
    const messages = [{ role: "user" as const, content: "x".repeat(4 * 30_000) }];
    const opts = { thresholdTokens: 50_000 };
    expect(shouldAutoCompact(messages, { ...opts, overheadTokens: 0 })).toBe(
      shouldAutoCompact(messages, opts),
    );
  });

  it("can trigger on overhead alone when the window is small enough", () => {
    // A 32k window with ~14k of system + tools is already 44% spent before the
    // first message; the trigger has to see that.
    expect(
      shouldAutoCompact([{ role: "user", content: "hi" }], {
        contextWindowSize: 32_000,
        overheadTokens: 30_000,
      }),
    ).toBe(true);
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
    // Wrapped in a <compacted> tag so the model reads it, and stamped
    // meta.kind so the slice/TUI recognize the boundary structurally.
    const content = r.messages[0]?.content;
    expect(typeof content === "string" && content.startsWith("<compacted>")).toBe(true);
    expect(content).toContain("</compacted>");
    expect(r.messages[0]?.meta).toEqual({ synthetic: true, kind: "compacted" });
    expect(isCompactionMarker(r.messages[0]!)).toBe(true);
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
      call: vi.fn(async (): Promise<AssistantTurn> => ({ content: [], stopReason: "end_turn" })),
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
    expect(prompt).toContain("Write a structured summary");
    expect(prompt).toContain("y".repeat(200_000));
  });
});
