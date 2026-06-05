import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import { buildLiveDraftItems, buildRenderItems } from "./render-item.js";

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
