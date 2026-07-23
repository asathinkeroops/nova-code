import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import wrapAnsi from "wrap-ansi";
import { highlightMarkdownSource, renderMarkdown } from "./markdown.js";

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// Terminal display width as `wrap-ansi` (the viewport's downstream wrapper) sees
// it — the same `string-width` primitive the renderer now measures with. Used to
// assert table rows line up on screen, not just in the renderer's own math.
const termWidth = (s: string): number => stringWidth(s);

// True iff a rendered row would be hard-wrapped by `measure.ts` at `width` — the
// exact chop that splits a table border onto a phantom line and garbles the box.
const wouldChop = (row: string, width: number): boolean =>
  wrapAnsi(row, width, { hard: true, wordWrap: false, trim: false }).split("\n").length > 1;

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

describe("renderMarkdown tables that overflow the terminal width", () => {
  // The `↔` (U+2194) in the last row is a text-presentation symbol that
  // `string-width`/`wrap-ansi` count as two cells: it was the regression that
  // slipped past a narrower hand-rolled measure and got a border chopped.
  const src = [
    "| 机制 | 说明 |",
    "| --- | --- |",
    "| Hook 体系 | 唯一的扩展点，所有横切关注点都通过 HookRegistry 挂载，blocking hook 的第一个非 undefined 返回即生效 |",
    "| max_tokens 可恢复 | 响应被截断且无 tool_use 时不会直接失败，而是提示模型继续，最多若干次连续重试 |",
    "| 防御深度 | 即使某个 slot 丢掉 result，末尾也会补一个 is_error 的 tool_result，保证 tool_use↔tool_result 配对绝不落空 |",
  ].join("\n");

  it("keeps every rendered row within the given width", () => {
    const width = 60;
    const rows = strip(renderMarkdown(src, width)).split("\n");
    for (const row of rows) expect(termWidth(row)).toBeLessThanOrEqual(width);
  });

  it("never lets the downstream wrapper chop a border off a row", () => {
    // The actual bug: a row measured narrow by the renderer but wide by
    // `wrap-ansi` gets its trailing `│` wrapped onto a phantom line. Guard the
    // full range of widths a table might overflow at.
    for (const width of [40, 50, 60, 80, 100, 120]) {
      const rows = strip(renderMarkdown(src, width)).split("\n");
      for (const row of rows) expect(wouldChop(row, width)).toBe(false);
    }
  });

  it("keeps all borders and wrapped content rows the same terminal width", () => {
    const rows = strip(renderMarkdown(src, 60)).split("\n");
    // Once a long cell wraps into its bounded column, every emitted line — top
    // border, headers, wrapped body rows, separators, bottom border — must be
    // the same visible width or the vertical bars drift (the garbling bug).
    const widths = new Set(rows.map(termWidth));
    expect(widths.size).toBe(1);
  });

  it("wraps a long cell onto multiple rows instead of one over-wide line", () => {
    // Three body rows with long cells + a header, plus 5 borders. If the long
    // cells wrap, the body spans more than one row each, so the total line count
    // exceeds the un-wrapped 4 content + 5 border case.
    const rows = strip(renderMarkdown(src, 60)).split("\n");
    expect(rows.length).toBeGreaterThan(9);
  });

  it("leaves a table that already fits unwrapped (natural widths)", () => {
    const small = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    // A 100-col terminal easily fits this table, so passing width must produce
    // the same output as the width-agnostic path.
    expect(renderMarkdown(small, 100)).toBe(renderMarkdown(small));
  });
});
