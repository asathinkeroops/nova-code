import { describe, expect, it } from "vitest";
import { highlightRow } from "./picker.js";
import { stripAnsi, visibleWidth } from "./width.js";

// The drag-selection background reused for the picker's selected row.
const SEL_BG_OPEN = "\x1b[48;2;45;80;130m";
const SEL_BG_CLOSE = "\x1b[49m";

describe("highlightRow", () => {
  it("pads a short row to the bar width so the highlight spans the whole line", () => {
    const out = highlightRow("hi", 6);
    // Visible content is the text right-padded with spaces to the bar width.
    expect(stripAnsi(out)).toBe("hi    ");
    expect(visibleWidth(out)).toBe(6);
    expect(out.startsWith(SEL_BG_OPEN)).toBe(true);
    expect(out.endsWith(SEL_BG_CLOSE)).toBe(true);
  });

  it("wraps a row already at full width without extra padding", () => {
    const out = highlightRow("abcd", 4);
    expect(stripAnsi(out)).toBe("abcd");
    expect(visibleWidth(out)).toBe(4);
  });

  it("keeps embedded foreground colours and re-opens the background after them", () => {
    // A raw fg-reset embedded mid-row, as colour helpers (dim/green) emit on a
    // real TTY. The reset must be followed by a re-opened background so it
    // doesn't punch a hole through the bar.
    const out = highlightRow("x\x1b[39my", 4);
    expect(stripAnsi(out)).toBe("xy  ");
    expect(out).toContain(`\x1b[39m${SEL_BG_OPEN}`);
  });

  it("measures wide (CJK) characters as two columns when padding", () => {
    const out = highlightRow("你好", 6); // 你好 == 4 visible columns
    expect(stripAnsi(out)).toBe("你好  ");
    expect(visibleWidth(out)).toBe(6);
  });
});
