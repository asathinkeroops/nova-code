import { describe, expect, it } from "vitest";
import { createPasteResolver } from "./mouse.js";

const START = "\x1b[200~";
const END = "\x1b[201~";
const CTRL_V = "\x16";

describe("createPasteResolver", () => {
  it("passes ordinary typing through untouched", () => {
    const r = createPasteResolver();
    expect(r("hello")).toBe("hello");
    expect(r(" world")).toBe(" world");
  });

  it("strips markers from a text paste, keeping the inner text", () => {
    const r = createPasteResolver();
    expect(r(`${START}pasted text${END}`)).toBe("pasted text");
  });

  it("turns an empty paste into a synthetic Ctrl+V (image gesture)", () => {
    const r = createPasteResolver();
    expect(r(`${START}${END}`)).toBe(CTRL_V);
  });

  it("preserves text surrounding a paste block", () => {
    const r = createPasteResolver();
    expect(r(`a${START}b${END}c`)).toBe("abc");
    const r2 = createPasteResolver();
    expect(r2(`x${START}${END}y`)).toBe(`x${CTRL_V}y`);
  });

  it("resolves a paste whose body spans multiple chunks", () => {
    const r = createPasteResolver();
    expect(r(`${START}foo`)).toBe("");
    expect(r("bar")).toBe("");
    expect(r(`baz${END}`)).toBe("foobarbaz");
  });

  it("resolves a start marker split across chunks without leaking it as text", () => {
    const r = createPasteResolver();
    expect(r("hi\x1b[2")).toBe("hi");
    expect(r(`00~body${END}`)).toBe("body");
  });

  it("resolves an end marker split across chunks", () => {
    const r = createPasteResolver();
    expect(r(`${START}body\x1b[20`)).toBe("");
    expect(r("1~tail")).toBe("bodytail");
  });

  it("handles an empty paste split across chunks", () => {
    const r = createPasteResolver();
    expect(r(START)).toBe("");
    expect(r(END)).toBe(CTRL_V);
  });
});
