import { describe, expect, it } from "vitest";
import { GLM_ART, GLM_ART_WIDTH } from "./glm-art.js";

// The renderer lays each row out as a flat run of `▀` cells; if the run lengths
// don't sum to the same width on every row the image shears. Guard the data
// shape so a regenerate with a bad width can't slip in.
describe("GLM_ART", () => {
  it("has at least one row", () => {
    expect(GLM_ART.length).toBeGreaterThan(0);
  });

  it("every row's spans sum to the declared width", () => {
    for (const [y, row] of GLM_ART.entries()) {
      const total = row.reduce((n, [, , count]) => n + count, 0);
      expect(total, `row ${y}`).toBe(GLM_ART_WIDTH);
    }
  });

  it("every span carries two 6-digit hex colors and a positive count", () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const row of GLM_ART) {
      for (const [fg, bg, count] of row) {
        expect(fg).toMatch(hex);
        expect(bg).toMatch(hex);
        expect(count).toBeGreaterThan(0);
        expect(Number.isInteger(count)).toBe(true);
      }
    }
  });
});
