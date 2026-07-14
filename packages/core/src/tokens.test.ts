import { describe, expect, it } from "vitest";
import { DEFAULT_TOKEN_ESTIMATE, estimateTextTokens, isCjkCodePoint } from "./tokens.js";

describe("isCjkCodePoint", () => {
  it("classifies CJK ideographs, kana, and hangul as CJK", () => {
    expect(isCjkCodePoint("世".codePointAt(0)!)).toBe(true); // ideograph
    expect(isCjkCodePoint("あ".codePointAt(0)!)).toBe(true); // hiragana
    expect(isCjkCodePoint("カ".codePointAt(0)!)).toBe(true); // katakana
    expect(isCjkCodePoint("한".codePointAt(0)!)).toBe(true); // hangul
  });

  it("classifies Latin, digits, and punctuation as non-CJK", () => {
    expect(isCjkCodePoint("a".codePointAt(0)!)).toBe(false);
    expect(isCjkCodePoint("7".codePointAt(0)!)).toBe(false);
    expect(isCjkCodePoint("{".codePointAt(0)!)).toBe(false);
  });
});

describe("estimateTextTokens", () => {
  it("weights CJK and non-CJK characters separately", () => {
    // 8 latin + 4 CJK under the default {cjk:0.6, other:0.3}.
    expect(estimateTextTokens("hello wo世界你好")).toBe(Math.ceil(8 * 0.3 + 4 * 0.6));
  });

  it("uses the default estimate when no weights are given", () => {
    expect(estimateTextTokens("x".repeat(10))).toBe(Math.ceil(10 * DEFAULT_TOKEN_ESTIMATE.other));
  });

  it("honors custom weights (a different provider's tokenizer)", () => {
    const weights = { cjk: 1, other: 0.25 };
    expect(estimateTextTokens("ab世", weights)).toBe(Math.ceil(2 * 0.25 + 1 * 1));
  });

  it("counts astral code points once (iterates by code point, not UTF-16 unit)", () => {
    // An emoji is a single non-CJK code point despite being a surrogate pair.
    expect(estimateTextTokens("😀", { cjk: 0.6, other: 1 })).toBe(1);
  });

  it("returns 0 for the empty string", () => {
    expect(estimateTextTokens("")).toBe(0);
  });
});
