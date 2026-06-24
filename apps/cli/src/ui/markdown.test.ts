import { describe, expect, it } from "vitest";
import { highlightMarkdownSource, renderMarkdown } from "./markdown.js";

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// Emoji-aware visible width, independent of the renderer's internal measure:
// counts CJK and emoji-presentation chars (✅ ❌ 中) as two terminal cells. Used
// to assert table rows line up on screen, not just in the renderer's own math.
const termWidth = (s: string): number => {
  let w = 0;
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f) continue; // variation selector renders zero-width
    const wide =
      cp === 0x2705 ||
      cp === 0x274c ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
};

describe("highlightMarkdownSource", () => {
  it("preserves line count 1:1 (diff/gutter mapping depends on it)", () => {
    const src = ["# Title", "", "- **bold** item", "", "```js", "const x = 1", "```", "end"].join(
      "\n",
    );
    const out = highlightMarkdownSource(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
  });

  it("keeps the raw source text intact (markers not stripped)", () => {
    const src = "# Title\n\n- **bold** and `code` and [x](y)";
    const out = highlightMarkdownSource(src);
    expect(strip(out)).toBe(src);
  });

  it("handles an unterminated fence without losing lines", () => {
    const src = "```ts\nconst x = 1\nmore";
    const out = highlightMarkdownSource(src);
    expect(out.split("\n")).toHaveLength(3);
  });
});

describe("renderMarkdown tables with emoji", () => {
  it("keeps borders aligned when cells mix emoji and CJK", () => {
    // Mirrors the kind of comparison table that drifted: ✅/❌ (Dingbats, not in
    // the CJK ranges) were measured as one cell but render as two.
    const src = [
      "| 能力 | Nova | Aider |",
      "| --- | --- | --- |",
      "| MCP 工具 | ✅ 完整 | ❌ 不支持 |",
      "| Hook 系统 | ✅ 16 个 hook 点 | ❌ |",
    ].join("\n");
    const rows = strip(renderMarkdown(src)).split("\n");
    // Every border + content row must occupy the same number of terminal cells,
    // or the vertical bars won't line up under each other on screen.
    const widths = new Set(rows.map(termWidth));
    expect(widths.size).toBe(1);
  });

  it("sizes a column to the doubled width of an emoji-only cell", () => {
    const src = ["| a |", "| --- |", "| ✅ |"].join("\n");
    const top = strip(renderMarkdown(src)).split("\n")[0] ?? "";
    // Column width = max(len('a')=1, width('✅')=2) = 2, so the border is
    // `┌` + 2+2 dashes + `┐`. Before the emoji-width fix it was 3 dashes.
    expect(top).toBe("┌────┐");
  });
});
