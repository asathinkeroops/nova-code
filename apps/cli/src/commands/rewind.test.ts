import { describe, expect, it } from "vitest";
import type { MessageParam } from "@nova/core";
import { collectUserTurns } from "./rewind.js";

const userTurn = (text: string): MessageParam => ({ role: "user", content: text });
const assistant = (text: string): MessageParam => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolResult = (id: string): MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

describe("collectUserTurns", () => {
  it("returns nothing for an empty or assistant-only history", () => {
    expect(collectUserTurns([])).toEqual([]);
    expect(collectUserTurns([assistant("hi")])).toEqual([]);
  });

  it("numbers genuine prompts oldest-first and records their index", () => {
    const messages = [userTurn("first"), assistant("ok"), userTurn("second")];
    const turns = collectUserTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ index: 0, turn: 1, text: "first" });
    expect(turns[1]).toMatchObject({ index: 2, turn: 2, text: "second" });
  });

  it("skips tool_result-only user messages so turns count real prompts", () => {
    const messages = [
      userTurn("do a thing"),
      assistant("calling tool"),
      toolResult("call_1"),
      assistant("done"),
      userTurn("next"),
    ];
    const turns = collectUserTurns(messages);
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(turns.map((t) => t.index)).toEqual([0, 4]);
  });

  it("flattens whitespace and truncates the label but keeps full text", () => {
    const long = "a".repeat(200);
    const [turn] = collectUserTurns([userTurn(`line one\n  line   two ${long}`)]);
    expect(turn?.text).toBe(`line one\n  line   two ${long}`);
    expect(turn?.label).toHaveLength(80);
    expect(turn?.label.endsWith("...")).toBe(true);
    expect(turn?.label).not.toContain("\n");
  });
});
