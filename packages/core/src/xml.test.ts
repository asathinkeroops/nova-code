import { describe, expect, it } from "vitest";
import { xmlAttr, xmlEscape } from "./xml.js";

describe("xmlEscape", () => {
  it("escapes &, <, >", () => {
    expect(xmlEscape("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("escapes a closing tag inside content so wrapping is preserved", () => {
    expect(xmlEscape("foo </long-running-command> bar")).toBe(
      "foo &lt;/long-running-command&gt; bar",
    );
  });

  it("does not touch quotes", () => {
    expect(xmlEscape('he said "hi"')).toBe('he said "hi"');
  });

  it("leaves plain text untouched", () => {
    expect(xmlEscape("hello world 123")).toBe("hello world 123");
  });
});

describe("xmlAttr", () => {
  it("escapes &, <, and double quotes", () => {
    expect(xmlAttr('a & b < "c"')).toBe("a &amp; b &lt; &quot;c&quot;");
  });

  it("does not escape `>` (legal inside attribute values)", () => {
    expect(xmlAttr("a > b")).toBe("a > b");
  });

  it("leaves plain text untouched", () => {
    expect(xmlAttr("just-a-name")).toBe("just-a-name");
  });
});
