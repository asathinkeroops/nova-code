import { describe, expect, it } from "vitest";
import { pickListRows, pickHorizontalRows } from "./viewport.js";
import type { HorizontalPickerOptions, PickerOptions } from "./picker.js";

const list = (over: Partial<PickerOptions<unknown>>): PickerOptions<unknown> => ({
  items: ["a"],
  render: (s) => String(s),
  ...over,
});

describe("pickListRows", () => {
  it("reserves border(2) + margins(2) + header + items + footer", () => {
    // 1 item, single-line header + footer: 4 chrome + 1 header + 1 item + 1 footer.
    const rows = pickListRows(list({ header: "pick:", footer: "esc", items: ["a"] }), 80);
    expect(rows).toBe(7);
  });

  it("counts a long header that wraps as multiple rows", () => {
    const longHeader =
      "rewind to which message? everything after it is discarded and cannot be undone later";
    const wide = pickListRows(list({ header: longHeader, items: ["a"] }), 200);
    const narrow = pickListRows(list({ header: longHeader, items: ["a"] }), 30);
    // Same content, narrower terminal → header wraps → strictly more rows.
    expect(narrow).toBeGreaterThan(wide);
    // Regression guard: the old `items.length + 2` estimate returned 3 here.
    expect(narrow).toBeGreaterThan(3);
  });

  it("drops the 2 border rows when border:false", () => {
    const base = { header: "pick:", footer: "esc", items: ["a"] };
    const bordered = pickListRows(list({ ...base }), 80);
    const borderless = pickListRows(list({ ...base, border: false }), 80);
    expect(bordered - borderless).toBe(2);
  });

  it("keeps one top-border row for a top-rule overlay (border:false + topRuleColor)", () => {
    const base = { header: "pick:", footer: "esc", items: ["a"] };
    const bordered = pickListRows(list({ ...base }), 80);
    const topRule = pickListRows(list({ ...base, border: false, topRuleColor: "#7c3aed" }), 80);
    // Only the bottom border row is dropped; the top rule still occupies a row.
    expect(bordered - topRule).toBe(1);
  });

  it("counts each row as one line in a full-width panel (rows truncate, never wrap)", () => {
    // A row far wider than the terminal would wrap to many lines in a plain
    // borderless list, but a top-rule panel truncates it to a single line — so
    // selecting a long row can't change the panel height (no header-clipping jump).
    const long = "x".repeat(400);
    const panel = pickListRows(list({ items: [long], border: false, topRuleColor: "#7c3aed" }), 80);
    expect(panel).toBe(4); // margins(2) + top rule(1) + 1 item line
    const plain = pickListRows(list({ items: [long], border: false }), 80);
    expect(plain).toBeGreaterThan(panel); // plain borderless still wraps
  });

  it("caps item rows at pageSize and adds the (n/m) indicator", () => {
    const many = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const rows = pickListRows(list({ items: many, pageSize: 10 }), 80);
    // 4 chrome + 10 visible items + 1 indicator (no header/footer) = 15.
    expect(rows).toBe(15);
  });
});

describe("pickHorizontalRows", () => {
  it("accounts for border + margins + padding + spacers + multi-line header", () => {
    const opts: HorizontalPickerOptions<boolean> = {
      items: [true, false],
      label: (b) => (b ? "ok" : "cancel"),
      header: "line1\nline2\nline3",
      footer: "esc",
    };
    // chrome 6 + 3 header lines + (blank+buttons+blank = 3) + 1 footer = 13.
    expect(pickHorizontalRows(opts as HorizontalPickerOptions<unknown>, 80)).toBe(13);
  });
});
