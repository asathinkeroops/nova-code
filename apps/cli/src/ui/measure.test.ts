import { describe, expect, it } from "vitest";
import type { RenderItem } from "./render-item.js";
import { sliceLines } from "./measure.js";

const tc = (id: string): RenderItem => ({
  kind: "tool-call",
  key: id,
  use: { type: "tool_use", id, name: "read", input: { path: `${id}.ts` } },
  result: { type: "tool_result", tool_use_id: id, content: "ok" },
});

const batch = (key: string, ids: string[], collapsed: boolean): RenderItem => ({
  kind: "tool-batch",
  key,
  collapsed,
  members: ids.map((id) => ({
    use: { type: "tool_use", id, name: "read", input: {} },
    result: { type: "tool_result", tool_use_id: id, content: "ok" },
  })),
});

describe("sliceLines targets", () => {
  const WIDTH = 80;

  it("tags only a collapsed batch's single title row with its key", () => {
    const items: RenderItem[] = [tc("a"), batch("b1", ["r1", "r2"], true)];
    const slice = sliceLines(items, WIDTH, 0, 50);
    expect(slice.targets).toHaveLength(slice.lines.length);
    // The tool-call lines carry null; the one batch title row carries the key.
    expect(slice.targets.filter((t) => t === "b1")).toEqual(["b1"]);
    const idx = slice.targets.indexOf("b1");
    expect(slice.lines[idx]).toContain("Read 2 files");
  });

  it("tags only the first (title) row of an expanded batch", () => {
    const items: RenderItem[] = [batch("b1", ["r1", "r2"], false)];
    const slice = sliceLines(items, WIDTH, 0, 50);
    // Expanded batch spans many rows but only the first is the clickable target.
    expect(slice.targets[0]).toBe("b1");
    expect(slice.targets.slice(1).every((t) => t === null)).toBe(true);
  });

  it("keeps targets aligned 1:1 with lines after scrolling", () => {
    const items: RenderItem[] = [tc("a"), tc("b"), batch("b1", ["r1", "r2"], true)];
    const slice = sliceLines(items, WIDTH, 1, 50);
    expect(slice.targets).toHaveLength(slice.lines.length);
  });

  it("tags a collapsed thinking block's hint row with its key", () => {
    const long = Array.from({ length: 8 }, (_, i) => `reasoning line ${i}`).join("\n");
    const items: RenderItem[] = [
      { kind: "thinking", key: "th#1", thinking: long, collapsed: true },
    ];
    const slice = sliceLines(items, WIDTH, 0, 50);
    expect(slice.targets.filter((t) => t === "th#1")).toEqual(["th#1"]);
    const idx = slice.targets.indexOf("th#1");
    expect(slice.lines[idx]).toContain("+5 lines");
  });

  it("does not tag a thinking block whose body fits the preview", () => {
    const items: RenderItem[] = [
      { kind: "thinking", key: "th#1", thinking: "a\nb", collapsed: true },
    ];
    const slice = sliceLines(items, WIDTH, 0, 50);
    expect(slice.targets.every((t) => t === null)).toBe(true);
  });
});
