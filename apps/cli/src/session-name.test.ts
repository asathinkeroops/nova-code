import { describe, expect, it } from "vitest";
import { MAX_SESSION_NAME_UNITS, normalizeSessionName } from "./session-name.js";

describe("normalizeSessionName", () => {
  it("collapses runs of whitespace and trims the ends", () => {
    expect(normalizeSessionName("  fix   the   bug  ")).toBe("fix the bug");
  });

  it("keeps a short name untouched", () => {
    expect(normalizeSessionName("payments refactor")).toBe("payments refactor");
  });

  it("counts each word and each interior space as a unit", () => {
    // 16 words + 15 spaces = 31 units -> drops back to 15 words + 15 spaces = 30
    const words = Array.from({ length: 16 }, (_, i) => `w${i}`);
    const out = normalizeSessionName(words.join(" "));
    // units kept = 15 words + 15 spaces (trailing space trimmed) = "w0 ... w14"
    expect(out.split(" ")).toHaveLength(15);
    expect(out.split(" ").at(-1)).toBe("w14");
  });

  it("keeps a long single word whole (one word unit)", () => {
    const word = "supercalifragilisticexpialidocious";
    expect(normalizeSessionName(word)).toBe(word);
  });

  it("caps CJK at 30 characters", () => {
    const out = normalizeSessionName("中".repeat(40));
    expect(Array.from(out)).toHaveLength(MAX_SESSION_NAME_UNITS);
  });

  it("counts spaces between CJK words too", () => {
    // 中文(2) + space(1) + 测试(2) = 5 units, well under the cap
    expect(normalizeSessionName("中文 测试")).toBe("中文 测试");
  });

  it("trims a trailing space left by the cut", () => {
    // 29 CJK chars (units 1-29) + space (unit 30) + "x" (would be unit 31 -> cut).
    const out = normalizeSessionName(`${"中".repeat(29)} x`);
    expect(out).toBe("中".repeat(29));
    expect(out.endsWith(" ")).toBe(false);
  });
});
