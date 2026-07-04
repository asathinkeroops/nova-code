import { describe, expect, it } from "vitest";
import { DEEPSEEK_ART, DEEPSEEK_ART_WIDTH } from "./deepseek-art.js";

// The renderer lays each row out as a flat run of `▀` cells; if the run lengths
// don't sum to the same width on every row the image shears. Guard the data
// shape so a regenerate with a bad width can't slip in.
describe("DEEPSEEK_ART", () => {
  it("has at least one row", () => {
    expect(DEEPSEEK_ART.length).toBeGreaterThan(0);
  });

  it("every row's spans sum to the declared width", () => {
    for (const [y, row] of DEEPSEEK_ART.entries()) {
      const total = row.reduce((n, [, , count]) => n + count, 0);
      expect(total, `row ${y}`).toBe(DEEPSEEK_ART_WIDTH);
    }
  });

  it("every span carries two 6-digit hex colors and a positive count", () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const row of DEEPSEEK_ART) {
      for (const [fg, bg, count] of row) {
        expect(fg).toMatch(hex);
        expect(bg).toMatch(hex);
        expect(count).toBeGreaterThan(0);
        expect(Number.isInteger(count)).toBe(true);
      }
    }
  });
});
