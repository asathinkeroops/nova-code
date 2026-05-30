import { describe, it, expect } from "vitest";
import {
  contextBar,
  displayCwd,
  fitSegments,
  formatDuration,
  formatTokenCount,
  type StatusSegment,
} from "./status-format.js";

describe("formatDuration", () => {
  it("shows hours/minutes/seconds for long spans", () => {
    expect(formatDuration((49 * 3600 + 48 * 60 + 42) * 1000)).toBe("49h48m42s");
  });
  it("drops the hours unit when zero", () => {
    expect(formatDuration((3 * 60 + 5) * 1000)).toBe("3m5s");
  });
  it("shows only seconds under a minute", () => {
    expect(formatDuration(7000)).toBe("7s");
  });
  it("clamps negatives to 0s", () => {
    expect(formatDuration(-1000)).toBe("0s");
  });
});

describe("formatTokenCount", () => {
  it("formats millions", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
  it("formats thousands", () => {
    expect(formatTokenCount(256_000)).toBe("256K");
    expect(formatTokenCount(200_000)).toBe("200K");
  });
  it("shows a decimal for fractional thousands", () => {
    expect(formatTokenCount(1_234)).toBe("1.2K");
    expect(formatTokenCount(12_345)).toBe("12.3K");
  });
  it("leaves small counts as-is", () => {
    expect(formatTokenCount(512)).toBe("512");
  });
});

describe("contextBar", () => {
  it("renders an empty bar below one cell's worth", () => {
    expect(contextBar(9)).toBe("░░░░░░░░░░");
  });
  it("renders a full bar at 100%", () => {
    expect(contextBar(100)).toBe("██████████");
  });
  it("floors partial fills", () => {
    expect(contextBar(35)).toBe("███░░░░░░░");
  });
  it("clamps out-of-range input", () => {
    expect(contextBar(250)).toBe("██████████");
    expect(contextBar(-5)).toBe("░░░░░░░░░░");
  });
});

describe("displayCwd", () => {
  it("collapses the home prefix to ~", () => {
    expect(displayCwd("/Users/x/Documents/github/nova", "/Users/x")).toBe(
      "~/Documents/github/nova",
    );
  });
  it("returns ~ for the home dir itself", () => {
    expect(displayCwd("/Users/x", "/Users/x")).toBe("~");
  });
  it("leaves non-home paths untouched", () => {
    expect(displayCwd("/etc/nova", "/Users/x")).toBe("/etc/nova");
  });
});

describe("fitSegments", () => {
  const segs: StatusSegment[] = [
    { icon: "⏱", text: "1h" }, // "⏱ 1h" = 4 cells
    { icon: "◆", text: "M" }, // "◆ M" = 3 cells
    { icon: "•", text: "dir" }, // "• dir" = 5 cells
  ];

  it("keeps all segments when they fit", () => {
    expect(fitSegments(segs, 100)).toHaveLength(3);
  });

  it("drops trailing segments that overflow", () => {
    // first (4) + sep(3) + second(3) = 10 fits; adding sep(3)+third(5) overflows.
    expect(fitSegments(segs, 10).map((s) => s.icon)).toEqual(["⏱", "◆"]);
  });

  it("returns nothing when even the first does not fit", () => {
    expect(fitSegments(segs, 2)).toEqual([]);
  });
});
