import type { MessageParam } from "@nova/core";
import { describe, expect, it } from "vitest";
import type { RenderItem } from "./render-item.js";
import { buildLiveDraftItems, buildRenderItems } from "./render-item.js";
import { renderItemToString } from "./render-strings.js";

describe("buildLiveDraftItems", () => {
  it("emits reasoning then the answer, each with a leading spacer", () => {
    const items = buildLiveDraftItems({ text: "answer", thinking: "reason" }, "high");
    expect(items.map((i) => i.kind)).toEqual(["spacer", "thinking", "spacer", "assistant-text"]);
    const th = items.find((i) => i.kind === "thinking");
    expect(th).toMatchObject({ thinking: "reason", label: "high" });
    const at = items.find((i) => i.kind === "assistant-text");
    expect(at).toMatchObject({ text: "answer" });
  });

  it("omits the thinking section when there's no reasoning", () => {
    const items = buildLiveDraftItems({ text: "answer", thinking: "" });
    expect(items.map((i) => i.kind)).toEqual(["spacer", "assistant-text"]);
  });

  it("omits the answer section when only reasoning has streamed", () => {
    const items = buildLiveDraftItems({ text: "", thinking: "reason" });
    expect(items.map((i) => i.kind)).toEqual(["spacer", "thinking"]);
  });

  it("returns nothing for an empty/whitespace draft", () => {
    expect(buildLiveDraftItems({ text: "", thinking: "" })).toEqual([]);
    expect(buildLiveDraftItems({ text: "   ", thinking: "\n" })).toEqual([]);
  });

  it("leaves the thinking label off when none is given", () => {
    const items = buildLiveDraftItems({ text: "", thinking: "reason" });
    const th = items.find((i) => i.kind === "thinking");
    expect(th && "label" in th ? th.label : undefined).toBeUndefined();
  });

  it("does not collapse live (still-streaming) thinking", () => {
    const items = buildLiveDraftItems({ text: "", thinking: "reason" });
    const th = items.find((i) => i.kind === "thinking");
    expect(th && th.kind === "thinking" ? th.collapsed : undefined).toBeFalsy();
  });
});

describe("buildRenderItems committed thinking", () => {
  const render = (content: MessageParam["content"]) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "assistant", content }],
    });

  it("renders a thinking block that carries reasoning", () => {
    const items = render([
      { type: "thinking", thinking: "reasoned", signature: "sig" },
      { type: "text", text: "answer" },
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "spacer",
      "thinking",
      "spacer",
      "assistant-text",
    ]);
  });

  it("marks committed thinking as collapsed (it is done)", () => {
    const items = render([{ type: "thinking", thinking: "reasoned", signature: "sig" }]);
    const th = items.find((i) => i.kind === "thinking");
    expect(th).toMatchObject({ collapsed: true });
  });

  it("skips an empty thinking block (no dangling header)", () => {
    const items = render([
      { type: "thinking", thinking: "", signature: "" },
      { type: "text", text: "answer" },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["spacer", "assistant-text"]);
    expect(items.some((i) => i.kind === "thinking")).toBe(false);
  });

  it("still renders a redacted_thinking block (encrypted reasoning exists)", () => {
    const items = render([
      { type: "redacted_thinking", data: "enc" },
      { type: "text", text: "answer" },
    ]);
    expect(items.some((i) => i.kind === "redacted-thinking")).toBe(true);
  });
});

describe("buildRenderItems block ordering", () => {
  const render = (content: MessageParam["content"]) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "assistant", content }],
    });

  const bash = (id: string) => ({
    type: "tool_use" as const,
    id,
    name: "bash",
    input: { command: "ls" },
  });

  it("renders narration text before the tool calls it introduces", () => {
    const items = render([
      { type: "text", text: "Let me check the deps." },
      bash("t1"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["spacer", "assistant-text", "spacer", "tool-call"]);
  });

  it("preserves text -> tool -> text interleaving as separate items", () => {
    const items = render([
      { type: "text", text: "first" },
      bash("t1"),
      { type: "text", text: "second" },
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "spacer",
      "assistant-text",
      "spacer",
      "tool-call",
      "spacer",
      "assistant-text",
    ]);
    const texts = items.filter((i) => i.kind === "assistant-text");
    expect(texts.map((t) => (t.kind === "assistant-text" ? t.text : ""))).toEqual([
      "first",
      "second",
    ]);
  });

  it("skips empty text blocks on a pure tool-call turn", () => {
    const items = render([{ type: "text", text: "" }, bash("t1")]);
    expect(items.map((i) => i.kind)).toEqual(["spacer", "tool-call"]);
  });
});

describe("buildRenderItems hides system-injected user messages", () => {
  const firstUserText = (content: string) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "user", content }],
    }).find((i) => i.kind === "user-text");

  it("renders a real typed prompt as a user bubble", () => {
    expect(firstUserText("real prompt")).toMatchObject({ text: "real prompt" });
  });

  it.each([
    "<reminder>Update your todos.</reminder>",
    '<background-command id="1" status="done">x</background-command>',
    "<interrupted-by-user></interrupted-by-user>",
    "<goal-eval>\nYour goal is not complete yet. Evaluation: tests fail\n</goal-eval>",
  ])("skips the bubble for injection %#", (content) => {
    expect(firstUserText(content)).toBeUndefined();
  });
});

describe("buildRenderItems user display overrides", () => {
  const userText = (overrides?: Record<string, string>) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "user", content: "EXPANDED model prompt" }],
      ...(overrides ? { userDisplayOverrides: overrides } : {}),
    }).find((i) => i.kind === "user-text");

  it("shows the original input when the message text matches an override key", () => {
    expect(userText({ "EXPANDED model prompt": "/agent reviewer audit foo.ts" })).toMatchObject(
      { text: "/agent reviewer audit foo.ts" },
    );
  });

  it("falls back to the raw message text when there is no override", () => {
    expect(userText()).toMatchObject({ text: "EXPANDED model prompt" });
    expect(userText({ "some other key": "x" })).toMatchObject({ text: "EXPANDED model prompt" });
  });

  it("applies overrides to text blocks too, not just string content", () => {
    const item = buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "user", content: [{ type: "text", text: "EXPANDED" }] }],
      userDisplayOverrides: { EXPANDED: "/plan ship it" },
    }).find((i) => i.kind === "user-text");
    expect(item).toMatchObject({ text: "/plan ship it" });
  });
});

describe("buildRenderItems sub-agent details", () => {
  const subagentUse = {
    type: "tool_use" as const,
    id: "sub-1",
    name: "createSubAgent",
    input: { description: "audit", type: "explore", prompt: "look" },
  };
  const toolCall = (toolDetails?: Record<string, import("@nova/subagent").SubAgentDetail[]>) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "assistant", content: [subagentUse] }],
      ...(toolDetails ? { toolDetails } : {}),
    }).find((i) => i.kind === "tool-call");

  it("attaches details to the matching tool-call item by tool_use id", () => {
    const item = toolCall({
      "sub-1": [
        { type: "thinking", text: "planning" },
        { type: "final", text: "done" },
      ],
    });
    expect(item).toMatchObject({
      details: [
        { type: "thinking", text: "planning" },
        { type: "final", text: "done" },
      ],
    });
  });

  it("omits details when none are recorded for the tool_use id", () => {
    expect(toolCall()).not.toHaveProperty("details");
    expect(toolCall({ "other-id": [{ type: "final", text: "x" }] })).not.toHaveProperty(
      "details",
    );
  });
});

describe("renderItemToString thinking collapse", () => {
  const WIDTH = 80;
  const thinking = (text: string, collapsed: boolean): string =>
    renderItemToString(
      { kind: "thinking", key: "k", thinking: text, collapsed } as RenderItem,
      WIDTH,
    );

  // 6 short lines stay well under the wrap width, so each is its own body row.
  const sixLines = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n");

  it("collapses a done thinking block to 3 body rows plus a hint", () => {
    const out = thinking(sixLines, true);
    expect(out).toContain("line 1");
    expect(out).toContain("line 3");
    expect(out).not.toContain("line 4");
    // header + 3 body rows + hint = 5 rows; 6 - 3 = 3 hidden.
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toContain("+3 lines");
  });

  it("does not collapse while still streaming (collapsed false)", () => {
    const out = thinking(sixLines, false);
    expect(out).toContain("line 6");
    expect(out).not.toContain("lines");
    expect(out.split("\n")).toHaveLength(7); // header + 6 body rows
  });

  it("shows no hint when the body already fits in 3 rows", () => {
    const out = thinking("line 1\nline 2", true);
    expect(out).not.toContain("lines");
    expect(out.split("\n")).toHaveLength(3); // header + 2 body rows
  });
});
