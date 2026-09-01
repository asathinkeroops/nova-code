import { describe, expect, it, vi } from "vitest";
import type { AssistantTurn, ModelClient, MessageParam, StopReason } from "@nova/core";
import { cleanPrediction, predictNextInput } from "./predict.js";

const HISTORY: MessageParam[] = [
  { role: "user", content: [{ type: "text", text: "帮我修复登录报错" }] },
  { role: "assistant", content: [{ type: "text", text: "好的，我来排查。" }] },
];

function stubModel(text: string, stopReason: StopReason): ModelClient {
  const turn: AssistantTurn = {
    content: [{ type: "text", text }],
    stopReason,
  };
  return {
    call: vi.fn(async () => turn),
  };
}

describe("predictNextInput", () => {
  it("returns the cleaned prediction on a clean end_turn", async () => {
    const model = stubModel("添加单元测试覆盖边界情况", "end_turn");
    const res = await predictNextInput({
      model,
      messages: HISTORY,
      maxChars: 300,
      timeoutMs: 8000,
    });
    expect(res.text).toBe("添加单元测试覆盖边界情况");
    expect(res.error).toBeUndefined();
    expect(res.stopReason).toBe("end_turn");
  });

  it("drops the result entirely when the model is truncated at max_tokens", async () => {
    const model = stubModel("修复登录报错，然后补一个回归测试，最后再把这", "max_tokens");
    const res = await predictNextInput({
      model,
      messages: HISTORY,
      maxChars: 300,
      timeoutMs: 8000,
    });
    expect(res.text).toBeNull();
    expect(res.error).toBe("truncated");
    expect(res.stopReason).toBe("max_tokens");
  });

  it("returns empty-text when the model streams no visible text", async () => {
    const model = stubModel("", "end_turn");
    const res = await predictNextInput({
      model,
      messages: HISTORY,
      maxChars: 300,
      timeoutMs: 8000,
    });
    expect(res.text).toBeNull();
    expect(res.error).toBe("empty-text");
  });

  it("instructs the model to emit one complete single-line sentence", async () => {
    const model = stubModel("添加单元测试", "end_turn");
    await predictNextInput({ model, messages: HISTORY, maxChars: 300, timeoutMs: 8000 });
    const req = vi.mocked(model.call).mock.calls[0]![0];
    expect(req.system).toContain("ONE complete imperative sentence");
    expect(req.system).toContain("single line");
    expect(req.system).toContain("finish the thought");
    expect(req.system).toContain("at most 300 characters");
    expect(req.system).toContain("no reasoning");
  });
});

describe("cleanPrediction", () => {
  it("keeps short text unchanged", () => {
    expect(cleanPrediction("修复登录报错", 300)).toBe("修复登录报错");
  });

  it("cuts a long CJK text at the nearest sentence end", () => {
    const raw = "请修复登录模块的报错，并在完成后补一个回归测试。这是很长的一段后续说明";
    // limit lands inside the second sentence — backtrack to the first "。".
    expect(cleanPrediction(raw, 30)).toBe("请修复登录模块的报错，并在完成后补一个回归测试。");
  });

  it("falls back to a clause boundary when no sentence end is in range", () => {
    const raw = "修复登录报错，然后补一个回归测试，最后再发布一条流水线";
    // No 。 in the head; cut at the first "，" instead of mid-word.
    expect(cleanPrediction(raw, 8)).toBe("修复登录报错，");
  });

  it("hard-cuts when there is no boundary at all", () => {
    expect(cleanPrediction("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghij");
  });

  it("trims a trailing space left by a word-boundary cut", () => {
    // "aaa bbb ccc" cut at 5 lands on the first space → "aaa " → trimmed to "aaa".
    expect(cleanPrediction("aaa bbb ccc", 5)).toBe("aaa");
  });

  it("strips control chars and surrounding quotes", () => {
    expect(cleanPrediction('"添加表单校验"', 300)).toBe("添加表单校验");
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(cleanPrediction("", 300)).toBeNull();
    expect(cleanPrediction("\n\n  ", 300)).toBeNull();
  });
});
