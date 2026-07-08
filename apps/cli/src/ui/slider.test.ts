import { describe, expect, it } from "vitest";
import { hslToRgb, type SliderPickerOptions, sliderRows, trackGeometry } from "./slider.js";

describe("trackGeometry", () => {
  it("centres each label and sums the track width (labels + 3-col separators)", () => {
    // off(3) sep(3) low(3) sep(3) medium(6) sep(3) high(4) sep(3) max(3)
    const { width, centers } = trackGeometry(["off", "low", "medium", "high", "max"]);
    expect(width).toBe(31);
    expect(centers).toEqual([1, 7, 15, 23, 29]);
  });

  it("handles a single item (centre inside its own span, no separators)", () => {
    const { width, centers } = trackGeometry(["medium"]);
    expect(width).toBe(6);
    expect(centers).toEqual([3]);
  });
});

describe("hslToRgb", () => {
  it("maps the primary hues to their RGB corners at full saturation", () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]); // red
    expect(hslToRgb(120, 1, 0.5)).toEqual([0, 255, 0]); // green
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 255]); // blue
  });

  it("wraps hue past 360 and below 0 so the animation cycles cleanly", () => {
    expect(hslToRgb(360, 1, 0.5)).toEqual(hslToRgb(0, 1, 0.5));
    expect(hslToRgb(-120, 1, 0.5)).toEqual(hslToRgb(240, 1, 0.5));
  });
});

describe("sliderRows", () => {
  const base: SliderPickerOptions<string> = {
    items: ["a", "b"],
    label: (s) => s,
  };

  it("reserves margins plus the scale and item rows", () => {
    // 2 margin + scale + item row.
    expect(sliderRows(base, 80)).toBe(4);
  });

  it("adds a spacer + footer line", () => {
    expect(sliderRows({ ...base, footer: "hint" }, 80)).toBe(4 + 2);
  });

  it("adds a row for the top rule when topRuleColor is set", () => {
    expect(sliderRows({ ...base, topRuleColor: "#7c3aed" }, 80)).toBe(4 + 1);
  });

  it("sizes the description block to the tallest item and adds its spacer", () => {
    const opts: SliderPickerOptions<string> = {
      items: ["a", "b"],
      label: (s) => s,
      description: (s) => (s === "a" ? "short" : "x".repeat(200)),
    };
    // width 80 → inner 76; the 200-char blurb wraps to 3 lines, so the block is
    // sized to that taller item even though "a" is one line.
    expect(sliderRows(opts, 80)).toBe(2 + 2 + (1 + 3));
  });
});
