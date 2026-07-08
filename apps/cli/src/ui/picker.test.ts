import { describe, expect, it } from "vitest";
import {
  firstSelectableIndex,
  highlightRow,
  lastSelectableIndex,
  stepSelectable,
  tintBarWidth,
  type ViewerLine,
} from "./picker.js";
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

describe("selectable-row navigation", () => {
  // A /help-shaped list: header (F), commands (T), header, commands, trailing notes.
  const help = [false, true, true, false, true, false, false];

  it("starts on the first selectable row when index 0 is a header", () => {
    expect(firstSelectableIndex(help)).toBe(1);
    expect(lastSelectableIndex(help)).toBe(4);
  });

  it("steps down skipping over the section header between groups", () => {
    // 1 → 2 (adjacent command), then 2 → 4 (skips the header at 3).
    expect(stepSelectable(1, help, 1)).toBe(2);
    expect(stepSelectable(2, help, 1)).toBe(4);
  });

  it("steps up skipping the header, wrapping past the trailing notes", () => {
    expect(stepSelectable(4, help, -1)).toBe(2);
    // From the top command, wrap around to the last selectable (skips notes+header).
    expect(stepSelectable(1, help, -1)).toBe(4);
  });

  it("stays put when no other row is selectable", () => {
    const one = [false, true, false];
    expect(stepSelectable(1, one, 1)).toBe(1);
    expect(stepSelectable(1, one, -1)).toBe(1);
  });

  it("falls back to safe indices when nothing is selectable", () => {
    const none = [false, false, false];
    expect(firstSelectableIndex(none)).toBe(0);
    expect(lastSelectableIndex(none)).toBe(2);
    expect(lastSelectableIndex([])).toBe(0);
  });
});

describe("tintBarWidth", () => {
  const g = (s: string): string => s; // gutter is already a plain string here
  const line = (gutter: string, text: string): ViewerLine => ({ gutter, text });

  it("uses the widest body when it fits within the row", () => {
    const visible = [line(g("12 "), "short"), line(g("13 "), "a bit longer")];
    // cols 80, border 2, gutter 3 → avail 75; widest body is 12.
    expect(tintBarWidth(visible, 80, true)).toBe(12);
  });

  it("caps the bar so gutter + bar never exceeds the inner width", () => {
    // One long line (130 cols) must not size the bar past the terminal edge,
    // or shorter rows' padding wraps onto blank continuation lines.
    const long = "x".repeat(130);
    const visible = [line(g("100 "), "short"), line(g("101 "), long)];
    const cols = 80;
    const bordered = true;
    const gutterW = 4;
    const bar = tintBarWidth(visible, cols, bordered);
    expect(bar).toBe(cols - 2 - gutterW); // 74
    expect(gutterW + bar).toBeLessThanOrEqual(cols - 2);
  });

  it("never returns less than 1 even on absurdly narrow terminals", () => {
    const visible = [line(g("      "), "content")];
    expect(tintBarWidth(visible, 4, true)).toBeGreaterThanOrEqual(1);
  });
});
