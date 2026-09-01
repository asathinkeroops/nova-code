import { describe, expect, it } from "vitest";
import {
  commandTokenRange,
  findCursorPosition,
  hitTestInput,
  historyRule,
  matchingFiles,
  mentionTokenAt,
  offsetForColumn,
  popupRow,
  sanitizePastedText,
  sessionNameBadge,
  styledSpans,
  wrapBuffer,
  type InputHitLayout,
  type SlashCommand,
} from "./input-box.js";
import { visibleWidth } from "./width.js";

const cmds: SlashCommand[] = [
  { name: "/agent", description: "delegate a task to a named sub-agent" },
  { name: "/agents", description: "list available sub-agent types" },
  { name: "/help", description: "show this help" },
  { name: "/compact", description: "summarize history" },
];

describe("commandTokenRange", () => {
  it("returns null when the buffer is not a slash command", () => {
    expect(commandTokenRange("", cmds)).toBeNull();
    expect(commandTokenRange("hello world", cmds)).toBeNull();
  });

  it("returns null for a bare slash (nothing typed yet)", () => {
    expect(commandTokenRange("/", cmds)).toBeNull();
  });

  it("highlights a prefix that matches at least one command", () => {
    expect(commandTokenRange("/h", cmds)).toEqual([0, 2]);
    expect(commandTokenRange("/co", cmds)).toEqual([0, 3]);
    // /ag is a prefix of both /agent and /agents — still one contiguous token
    expect(commandTokenRange("/ag", cmds)).toEqual([0, 3]);
  });

  it("highlights a fully-typed command name", () => {
    expect(commandTokenRange("/help", cmds)).toEqual([0, 5]);
    expect(commandTokenRange("/agent", cmds)).toEqual([0, 6]);
    expect(commandTokenRange("/agents", cmds)).toEqual([0, 7]);
  });

  it("highlights only the command token, not its arguments", () => {
    expect(commandTokenRange("/agent trace foo", cmds)).toEqual([0, 6]);
    expect(commandTokenRange("/compact   keep tests", cmds)).toEqual([0, 8]);
  });

  it("returns null for a typo or a non-command slash path", () => {
    expect(commandTokenRange("/agentt foo", cmds)).toBeNull();
    expect(commandTokenRange("/usr/bin", cmds)).toBeNull();
    expect(commandTokenRange("/nope", cmds)).toBeNull();
  });

  it("returns null when no commands are registered", () => {
    expect(commandTokenRange("/help", [])).toBeNull();
  });

  it("is case-insensitive and works with names lacking a leading slash", () => {
    expect(commandTokenRange("/HE", cmds)).toEqual([0, 3]);
    expect(commandTokenRange("/he", [{ name: "help", description: "" }])).toEqual([0, 3]);
  });
});

describe("mentionTokenAt", () => {
  it("returns null when the cursor is not in an @token", () => {
    expect(mentionTokenAt("", 0)).toBeNull();
    expect(mentionTokenAt("hello", 5)).toBeNull();
    expect(mentionTokenAt("hello world", 11)).toBeNull();
  });

  it("detects a bare @ at the buffer start", () => {
    expect(mentionTokenAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("detects an @token mid-buffer preceded by whitespace", () => {
    const buf = "look at @src/foo";
    expect(mentionTokenAt(buf, buf.length)).toEqual({ start: 8, end: 16, query: "src/foo" });
  });

  it("requires the @ to start a word (not mid-word like an email)", () => {
    const buf = "mail me a@b.com";
    expect(mentionTokenAt(buf, buf.length)).toBeNull();
  });

  it("clips the query at the cursor but spans the whole word in end", () => {
    // cursor after "src" while "src/foo.ts" is the full token under it
    const buf = "@src/foo.ts";
    expect(mentionTokenAt(buf, 4)).toEqual({ start: 0, end: 11, query: "src" });
  });

  it("never fires on a slash command line", () => {
    const buf = "/agent @foo";
    expect(mentionTokenAt(buf, buf.length)).toBeNull();
  });
});

describe("sessionNameBadge", () => {
  it("returns null for an empty or whitespace-only name", () => {
    expect(sessionNameBadge("", 80)).toBeNull();
    expect(sessionNameBadge("   ", 80)).toBeNull();
  });

  it("pads the name and leaves a trailing rule so it isn't flush-right", () => {
    const out = sessionNameBadge("api work", 40);
    expect(out).not.toBeNull();
    expect(out!.badge).toBe(" api work ");
    // lead + badge + trail spans exactly `width` columns
    expect(out!.lead.length + out!.badge.length + out!.trail.length).toBe(40);
    // a few rule chars sit to the right of the badge
    expect(out!.trail.length).toBe(3);
    expect(out!.lead.length).toBe(27);
  });

  it("trims surrounding whitespace before badging", () => {
    expect(sessionNameBadge("  hi  ", 40)?.badge).toBe(" hi ");
  });

  it("truncates a name too long for the frame, keeping one lead rule char", () => {
    const out = sessionNameBadge("a".repeat(100), 20);
    expect(out).not.toBeNull();
    expect(out!.lead.length).toBeGreaterThanOrEqual(1);
    expect(out!.lead.length + out!.badge.length + out!.trail.length).toBe(20);
  });
});

describe("historyRule", () => {
  it("embeds the position label and fills exactly `width` columns", () => {
    const out = historyRule(40, 2, 7);
    expect(out).toContain(" History 2/7 ");
    expect(out.length).toBe(40);
  });

  it("coexists with the session-name badge: label fills the badge's lead width", () => {
    const badge = sessionNameBadge("api work", 60)!;
    const left = historyRule(badge.lead.length, 3, 9);
    // left + badge + trail still spans the full frame width
    expect(left.length + badge.badge.length + badge.trail.length).toBe(60);
    expect(left).toContain(" History 3/9 ");
  });
});

describe("wrapBuffer with explicit newlines", () => {
  // Wide enough that width-wrapping never triggers; only `\n` breaks lines.
  const W = 80;

  it("breaks a line at each `\\n`, leaving the newline in no line's content", () => {
    const lines = wrapBuffer("ab\ncd", W);
    expect(lines.map((l) => l.content)).toEqual(["ab", "cd"]);
    // First line spans [0,2); the `\n` at offset 2 belongs to neither line.
    expect(lines[0]).toMatchObject({ bufStart: 0, bufEnd: 2, hardBreak: true });
    expect(lines[1]).toMatchObject({ bufStart: 3, bufEnd: 5 });
    // Content length always matches its buffer span (render invariant).
    for (const l of lines) expect(l.content.length).toBe(l.bufEnd - l.bufStart);
  });

  it("renders a blank row between consecutive newlines", () => {
    const lines = wrapBuffer("a\n\nb", W);
    expect(lines.map((l) => l.content)).toEqual(["a", "", "b"]);
    expect(lines[1]).toMatchObject({ bufStart: 2, bufEnd: 2, hardBreak: true });
  });

  it("appends an empty final row for a trailing newline so the caret has a home", () => {
    const lines = wrapBuffer("hi\n", W);
    expect(lines.map((l) => l.content)).toEqual(["hi", ""]);
    expect(lines[1]).toMatchObject({ bufStart: 3, bufEnd: 3 });
  });

  it("still soft-wraps by width within a hard-broken line", () => {
    // width 6 → firstCap = 6-1-2 = 3, restCap = 6-1 = 5.
    const lines = wrapBuffer("abcdef\nx", 6);
    expect(lines.map((l) => l.content)).toEqual(["abc", "def", "x"]);
    // The soft-wrap boundary (abc→def) is not a hard break; the `\n` one is.
    expect(lines[0]?.hardBreak).toBe(false);
    expect(lines[1]?.hardBreak).toBe(true);
  });
});

describe("findCursorPosition across hard breaks", () => {
  const W = 80;

  it("places the caret at the end of a line when it sits on that line's `\\n`", () => {
    const lines = wrapBuffer("ab\ncd", W);
    // Offset 2 is the newline itself → end of the first line, not start of second.
    expect(findCursorPosition(lines, 2)).toEqual({ row: 0, col: 2 });
    // Offset 3 is before 'c' → start of the second line.
    expect(findCursorPosition(lines, 3)).toEqual({ row: 1, col: 0 });
  });

  it("lands the caret on a blank row after a trailing newline", () => {
    const lines = wrapBuffer("hi\n", W);
    expect(findCursorPosition(lines, 3)).toEqual({ row: 1, col: 0 });
  });

  it("resolves each row of a double newline distinctly", () => {
    const lines = wrapBuffer("a\n\nb", W);
    expect(findCursorPosition(lines, 1)).toEqual({ row: 0, col: 1 }); // end of "a"
    expect(findCursorPosition(lines, 2)).toEqual({ row: 1, col: 0 }); // blank row
    expect(findCursorPosition(lines, 3)).toEqual({ row: 2, col: 0 }); // start of "b"
  });
});

describe("offsetForColumn", () => {
  const W = 80;

  it("maps a visual column to a buffer offset on the given line", () => {
    const lines = wrapBuffer("ab\ncd", W);
    // lines[0] = "ab" spanning [0,2); col 1 is the boundary after 'a'.
    expect(offsetForColumn(lines[0]!, 0)).toBe(0);
    expect(offsetForColumn(lines[0]!, 1)).toBe(1);
    expect(offsetForColumn(lines[0]!, 2)).toBe(2);
  });

  it("clamps to the line end when the target column runs past it", () => {
    const lines = wrapBuffer("ab\ncd", W);
    expect(offsetForColumn(lines[0]!, 99)).toBe(2);
    expect(offsetForColumn(lines[1]!, 99)).toBe(5);
  });

  it("resolves a wide char to its leading boundary, never splitting it", () => {
    const lines = wrapBuffer("中x", W);
    // '中' occupies two columns; a target inside it lands before it.
    expect(offsetForColumn(lines[0]!, 1)).toBe(0);
    expect(offsetForColumn(lines[0]!, 2)).toBe(1);
    expect(offsetForColumn(lines[0]!, 3)).toBe(2);
  });
});

describe("sanitizePastedText", () => {
  it("folds CRLF and lone CR to LF so pasted multi-line text keeps its breaks", () => {
    expect(sanitizePastedText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("strips control bytes (NUL, ESC, TAB) but preserves newlines", () => {
    // Only the control bytes are removed — matching the prior strip, the
    // printable tail of an escape sequence stays put.
    expect(sanitizePastedText("a\x00b\x1bc\td\ne")).toBe("abcd\ne");
  });

  it("leaves plain text untouched", () => {
    expect(sanitizePastedText("hello world")).toBe("hello world");
  });
});

describe("styledSpans", () => {
  interface SpanProps {
    children?: string;
    dimColor?: boolean;
    inverse?: boolean;
  }
  const props = (nodes: React.ReactNode[]): SpanProps[] =>
    nodes.map((n) => (n as React.ReactElement<SpanProps>).props);

  it("emits a trailing run of spaces dim so Ink's per-line trimEnd keeps it", () => {
    // Without a style Ink drops those cells, the frame comes out byte-identical
    // to the previous one, and the typed space never reaches the screen.
    const spans = props(styledSpans("hi  ", 0, null, false, null, null));
    expect(spans.map((p) => p.children)).toEqual(["hi", "  "]);
    expect(spans[0]?.dimColor).toBe(false);
    expect(spans[1]?.dimColor).toBe(true);
  });

  it("leaves interior spaces alone", () => {
    const spans = props(styledSpans("a b", 0, null, false, null, null));
    expect(spans.map((p) => p.children)).toEqual(["a b"]);
    expect(spans[0]?.dimColor).toBe(false);
  });

  it("keeps the inverse caret cell when the caret sits on a trailing space", () => {
    const spans = props(styledSpans("hi ", 0, 2, false, null, null));
    expect(spans.map((p) => p.children)).toEqual(["hi", " "]);
    expect(spans[1]?.inverse).toBe(true);
  });
});

describe("hitTestInput", () => {
  // A single-line layout: termRows 24, bottomChromeRows 2 (status line, no mode
  // indicator). base = 24 - 1 - 2 - bodyRows, so a 1-row body sits at row 20.
  const layout = (
    buffer: string,
    width = 80,
    termRows = 24,
    bottomChromeRows = 2,
  ): InputHitLayout => {
    const lines = wrapBuffer(buffer, width);
    return { lines, bodyRows: lines.length, termRows, bottomChromeRows };
  };

  it("returns null for rows above or below the body", () => {
    const l = layout("hello world");
    expect(hitTestInput(l, 19, 6)).toBeNull(); // one row above the body
    expect(hitTestInput(l, 21, 6)).toBeNull(); // one row below the body
  });

  it("maps the first content cell (col 4) to offset 0", () => {
    const l = layout("hello world");
    // Leading space (col 1) + "❯ " prompt (cols 2-3) → content starts at col 4.
    expect(hitTestInput(l, 20, 4)).toBe(0);
  });

  it("clamps a click in the prompt/leading space to the line start", () => {
    const l = layout("hello world");
    expect(hitTestInput(l, 20, 1)).toBe(0);
    expect(hitTestInput(l, 20, 3)).toBe(0);
  });

  it("maps each column to the char boundary under it", () => {
    const l = layout("hello world");
    expect(hitTestInput(l, 20, 5)).toBe(1); // after 'h'
    expect(hitTestInput(l, 20, 9)).toBe(5); // after 'hello'
  });

  it("lands a click past the end of the line at the line end", () => {
    const l = layout("hello world"); // 11 chars
    expect(hitTestInput(l, 20, 40)).toBe(11);
  });

  it("resolves wide (CJK) chars to whole-character boundaries", () => {
    const l = layout("中x"); // '中' is width 2 at cols 4-5, 'x' at col 6
    expect(hitTestInput(l, 20, 4)).toBe(0); // before 中
    expect(hitTestInput(l, 20, 5)).toBe(0); // within 中 → before it
    expect(hitTestInput(l, 20, 6)).toBe(1); // before x
    expect(hitTestInput(l, 20, 7)).toBe(2); // past end
  });

  it("hit-tests wrapped lines with no prompt offset on later rows", () => {
    // width 10 → firstCap 7, restCap 9. "abcdefghij" wraps to "abcdefg"/"hij".
    const l = layout("abcdefghij", 10);
    expect(l.bodyRows).toBe(2);
    // base = 24 - 1 - 2 - 2 = 19, so line 0 → row 19, line 1 → row 20.
    expect(hitTestInput(l, 19, 4)).toBe(0); // first line, content at col 4
    expect(hitTestInput(l, 20, 2)).toBe(7); // second line, content at col 2 (no prompt)
    expect(hitTestInput(l, 20, 3)).toBe(8);
  });

  it("maps a click on an empty buffer to offset 0", () => {
    const l = layout("");
    expect(l.bodyRows).toBe(1);
    expect(hitTestInput(l, 20, 4)).toBe(0);
  });
});

describe("matchingFiles", () => {
  const files = [
    "src/config.ts",
    "src/ui/input-box.tsx",
    "packages/base/src/config/config.ts",
    "README.md",
  ];

  it("ranks basename-prefix matches above substring matches", () => {
    const out = matchingFiles("config", files, 10);
    // both config.ts files match on basename prefix; the shorter path wins ties
    expect(out[0]).toBe("src/config.ts");
    expect(out).toContain("packages/base/src/config/config.ts");
  });

  it("matches on a path substring when the basename does not", () => {
    expect(matchingFiles("packages", files, 10)).toEqual(["packages/base/src/config/config.ts"]);
  });

  it("is case-insensitive", () => {
    expect(matchingFiles("readme", files, 10)).toEqual(["README.md"]);
  });

  it("excludes non-matches", () => {
    expect(matchingFiles("nope", files, 10)).toEqual([]);
  });

  it("returns the shortest paths first for an empty query", () => {
    expect(matchingFiles("", files, 2)).toEqual(["README.md", "src/config.ts"]);
  });

  it("honors the limit", () => {
    expect(matchingFiles("", files, 1)).toHaveLength(1);
  });
});

describe("popupRow", () => {
  const opts = { selected: false, nameWidth: 8, width: 40 };

  it("aligns descriptions at the shared name column", () => {
    expect(popupRow({ name: "/help", description: "show this help" }, opts)).toBe(
      "  /help     show this help",
    );
  });

  it("marks the selected row with an arrow", () => {
    expect(popupRow({ name: "/help", description: "" }, { ...opts, selected: true })).toBe(
      "\u276f /help",
    );
  });

  it("clips a long description to one line, ending in an ellipsis", () => {
    const row = popupRow({ name: "/fliggy", description: "x".repeat(200) }, opts);
    expect(visibleWidth(row)).toBeLessThanOrEqual(opts.width - 1);
    expect(row.endsWith("\u2026")).toBe(true);
  });

  it("flattens a multi-line description so it cannot wrap", () => {
    const row = popupRow({ name: "/a", description: "first line\n\nsecond line" }, opts);
    expect(row).not.toContain("\n");
    expect(row).toContain("first line second line");
  });

  it("clips a long name too (file mentions carry no description)", () => {
    const row = popupRow({ name: `src/${"deep/".repeat(30)}file.ts`, description: "" }, opts);
    expect(visibleWidth(row)).toBeLessThanOrEqual(opts.width - 1);
    expect(row.endsWith("\u2026")).toBe(true);
  });

  it("keeps CJK descriptions within the box width", () => {
    const row = popupRow(
      { name: "/trip", description: "\u98de\u732a\u5ea6\u5047\u6570\u636e".repeat(20) },
      opts,
    );
    expect(visibleWidth(row)).toBeLessThanOrEqual(opts.width - 1);
  });
});
