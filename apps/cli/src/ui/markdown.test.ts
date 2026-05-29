import { describe, expect, it } from "vitest";
import { highlightMarkdownSource } from "./markdown.js";

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

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
