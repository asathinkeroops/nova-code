import { describe, expect, it } from "vitest";
import { buildLiveDraftItems } from "./render-item.js";

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
