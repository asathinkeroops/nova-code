import { describe, it, expect } from "vitest";
import {
  cacheHitRate,
  contextBar,
  displayCwd,
  fitSegments,
  formatDuration,
  formatPercent,
  formatTokenCount,
  permissionModeIndicator,
  SHELL_MODE_INDICATOR,
  type StatusSegment,
} from "./status-format.js";
import { BASH_HEX } from "../colors.js";

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

describe("cacheHitRate", () => {
  it("is reads over all prompt tokens (read + write + uncached)", () => {
    // 80 read out of 80 + 15 write + 5 uncached = 100 → 0.8
    expect(cacheHitRate(80, 15, 5)).toBe(0.8);
  });
  it("returns null when no prompt tokens have been seen", () => {
    expect(cacheHitRate(0, 0, 0)).toBeNull();
  });
  it("is 0 when nothing was served from cache", () => {
    expect(cacheHitRate(0, 40, 60)).toBe(0);
  });
  it("is 1 when the whole prompt was a cache hit", () => {
    expect(cacheHitRate(100, 0, 0)).toBe(1);
  });
});

describe("formatPercent", () => {
  it("rounds a ratio to a whole percent", () => {
    expect(formatPercent(0.8523)).toBe("85%");
    expect(formatPercent(0.8556)).toBe("86%");
  });
  it("clamps out-of-range ratios", () => {
    expect(formatPercent(1.4)).toBe("100%");
    expect(formatPercent(-0.2)).toBe("0%");
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

describe("permissionModeIndicator", () => {
  it("shows nothing in default mode (no extra row below the status line)", () => {
    expect(permissionModeIndicator("default")).toBeNull();
  });

  it("labels accept-edits and plan in distinct colors (hint appended dim by the renderer)", () => {
    expect(permissionModeIndicator("acceptEdits")).toEqual({ label: "⏵⏵ accept edits on", color: "green" });
    expect(permissionModeIndicator("plan")).toEqual({ label: "⏸ plan mode on", color: "cyan" });
  });
});

describe("SHELL_MODE_INDICATOR", () => {
  it("labels shell mode in bash green for the status row", () => {
    expect(SHELL_MODE_INDICATOR).toEqual({ label: "! for shell mode", color: BASH_HEX });
  });
});
