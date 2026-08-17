import { describe, expect, it } from "vitest";
import {
  frontMatterBool,
  frontMatterList,
  frontMatterText,
  parseFrontMatter,
  splitFrontMatter,
} from "./front-matter.js";

describe("parseFrontMatter — scalars", () => {
  it("parses plain, quoted, and typed scalars", () => {
    expect(
      parseFrontMatter(
        [
          "name: code-reviewer",
          'title: "quoted: with colon"',
          "single: 'it''s here'",
          "count: 42",
          "ratio: 1.5",
          "flag: true",
          "off-flag: false",
          "empty:",
          "tilde: ~",
          "nulled: null",
        ].join("\n"),
      ),
    ).toEqual({
      name: "code-reviewer",
      title: "quoted: with colon",
      single: "it's here",
      count: 42,
      ratio: 1.5,
      flag: true,
      "off-flag": false,
      empty: null,
      tilde: null,
      nulled: null,
    });
  });

  it("keeps colons inside a plain scalar with the value", () => {
    expect(parseFrontMatter("description: Use this: for X")).toEqual({
      description: "Use this: for X",
    });
  });

  it("strips comments only outside quotes", () => {
    expect(
      parseFrontMatter(["a: value # trailing", 'b: "kept # inside"', "# whole line"].join("\n")),
    ).toEqual({
      a: "value",
      b: "kept # inside",
    });
  });

  it("does not treat a bare url as a comment or key", () => {
    expect(parseFrontMatter("url: https://example.com/a#b")).toEqual({
      url: "https://example.com/a#b",
    });
  });

  it("decodes escapes in double-quoted scalars", () => {
    expect(parseFrontMatter('a: "line\\nbreak \\"q\\" \\u0041"')).toEqual({
      a: 'line\nbreak "q" A',
    });
  });
});

describe("parseFrontMatter — collections", () => {
  it("parses flow sequences and mappings", () => {
    expect(
      parseFrontMatter(
        ["tools: [Read, Write, Bash]", "opts: {a: 1, b: two}", "empty: []"].join("\n"),
      ),
    ).toEqual({
      tools: ["Read", "Write", "Bash"],
      opts: { a: 1, b: "two" },
      empty: [],
    });
  });

  it("parses block sequences", () => {
    expect(parseFrontMatter(["tools:", "  - Read", "  - Write"].join("\n"))).toEqual({
      tools: ["Read", "Write"],
    });
  });

  it("parses nested block mappings — the shape that used to drop a whole skill", () => {
    expect(
      parseFrontMatter(
        ["name: nested", "metadata:", "  category: docs", "  version: 2", "trailing: yes"].join(
          "\n",
        ),
      ),
    ).toEqual({
      name: "nested",
      metadata: { category: "docs", version: 2 },
      trailing: true,
    });
  });

  it("parses sequences of mappings", () => {
    expect(
      parseFrontMatter(
        [
          "args:",
          "  - name: path",
          "    required: true",
          "  - name: mode",
          "    default: fast",
        ].join("\n"),
      ),
    ).toEqual({
      args: [
        { name: "path", required: true },
        { name: "mode", default: "fast" },
      ],
    });
  });

  it("parses deeply nested mixed structures", () => {
    expect(
      parseFrontMatter(
        ["hooks:", "  PreToolUse:", "    - matcher: Bash", "      command: ./check.sh"].join("\n"),
      ),
    ).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", command: "./check.sh" }] },
    });
  });
});

describe("parseFrontMatter — block and multi-line scalars", () => {
  it("folds a `>` block scalar — the other shape that used to drop a skill", () => {
    const meta = parseFrontMatter(
      [
        "name: folded",
        "description: >",
        "  a folded multi-line",
        "  description string",
        "after: 1",
      ].join("\n"),
    );
    expect(meta.description).toBe("a folded multi-line description string\n");
    expect(meta.after).toBe(1);
  });

  it("preserves newlines in a `|` block scalar", () => {
    const meta = parseFrontMatter(["body: |", "  line one", "  line two"].join("\n"));
    expect(meta.body).toBe("line one\nline two\n");
  });

  it("honors strip and keep chomping indicators", () => {
    expect(parseFrontMatter(["a: |-", "  x"].join("\n")).a).toBe("x");
    expect(parseFrontMatter(["a: |+", "  x", ""].join("\n")).a).toBe("x\n");
  });

  it("preserves relative indentation inside a block scalar", () => {
    expect(parseFrontMatter(["a: |", "  top", "    nested", "  back"].join("\n")).a).toBe(
      "top\n  nested\nback\n",
    );
  });

  it("folds a plain multi-line scalar continuation", () => {
    const meta = parseFrontMatter(
      ["description: this is a long", "  description continued here", "name: x"].join("\n"),
    );
    expect(meta.description).toBe("this is a long description continued here");
    expect(meta.name).toBe("x");
  });
});

describe("parseFrontMatter — resilience", () => {
  it("never throws on malformed input", () => {
    const nasty = [
      "just a bare line with no colon",
      "key: [unbalanced, flow",
      "  ",
      "\t\ttabs: indented",
      "?: weird",
      "valid: kept",
    ].join("\n");
    expect(() => parseFrontMatter(nasty)).not.toThrow();
    expect(parseFrontMatter(nasty).valid).toBe("kept");
  });

  it("keeps an unbalanced flow collection as a string rather than dropping it", () => {
    expect(parseFrontMatter("key: [a, b").key).toBe("[a, b");
  });

  it("returns an empty object for an empty or comment-only block", () => {
    expect(parseFrontMatter("")).toEqual({});
    expect(parseFrontMatter("# only a comment")).toEqual({});
  });

  it("ignores a top-level sequence", () => {
    expect(parseFrontMatter("- a\n- b")).toEqual({});
  });

  it("tolerates keys that are not at column zero", () => {
    expect(parseFrontMatter("  name: indented\n  description: d")).toEqual({
      name: "indented",
      description: "d",
    });
  });
});

describe("splitFrontMatter", () => {
  it("separates meta from body and reports presence", () => {
    const r = splitFrontMatter("---\nname: x\n---\n# Heading\n\ntext\n");
    expect(r.hasFrontMatter).toBe(true);
    expect(r.meta).toEqual({ name: "x" });
    expect(r.body).toBe("# Heading\n\ntext\n");
  });

  it("normalizes CRLF", () => {
    const r = splitFrontMatter("---\r\nname: x\r\n---\r\nbody\r\n");
    expect(r.meta).toEqual({ name: "x" });
    expect(r.body).toBe("body\n");
  });

  it("reports absence without consuming the document", () => {
    const r = splitFrontMatter("no front matter here\n");
    expect(r.hasFrontMatter).toBe(false);
    expect(r.body).toBe("no front matter here\n");
  });

  it("does not treat a horizontal rule mid-document as a delimiter", () => {
    const r = splitFrontMatter("# Title\n\n---\n\nmore\n");
    expect(r.hasFrontMatter).toBe(false);
  });
});

describe("coercion helpers", () => {
  it("frontMatterText stringifies scalars and refuses collections", () => {
    expect(frontMatterText("s")).toBe("s");
    expect(frontMatterText(2024)).toBe("2024");
    expect(frontMatterText(true)).toBe("true");
    expect(frontMatterText(null)).toBeUndefined();
    expect(frontMatterText(undefined)).toBeUndefined();
    expect(frontMatterText(["a"])).toBeUndefined();
  });

  it("frontMatterBool accepts real booleans and their string spellings", () => {
    expect(frontMatterBool(true, false)).toBe(true);
    expect(frontMatterBool("true", false)).toBe(true);
    expect(frontMatterBool("FALSE", true)).toBe(false);
    expect(frontMatterBool("maybe", true)).toBe(true);
    expect(frontMatterBool(undefined, true)).toBe(true);
  });

  it("frontMatterList normalizes sequences and lone scalars", () => {
    expect(frontMatterList(["a", "b"])).toEqual(["a", "b"]);
    expect(frontMatterList("a")).toEqual(["a"]);
    expect(frontMatterList(undefined)).toBeUndefined();
  });
});
