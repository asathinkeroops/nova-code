import { describe, it, expect } from "vitest";
import {
  cacheHitRate,
  cacheSegmentText,
  contextBar,
  displayCwd,
  fitSegments,
  formatDuration,
  formatElapsed,
  formatPercent,
  formatTokenCount,
  permissionModeIndicator,
  shellModeIndicator,
  type StatusSegment,
} from "./status-format.js";
import {
  BASH_HEX,
  MODE_ACCEPT_HEX,
  MODE_AUTO_HEX,
  MODE_BYPASS_HEX,
  MODE_MANUAL_HEX,
  MODE_PLAN_HEX,
} from "../colors.js";
import { setLocale } from "../i18n/index.js";
import type { PermissionMode } from "../permissions.js";

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

describe("formatElapsed", () => {
  it("shows only seconds under a minute", () => {
    expect(formatElapsed(40_000)).toBe("40s");
    expect(formatElapsed(0)).toBe("0s");
  });
  it("shows minutes and seconds under an hour", () => {
    expect(formatElapsed(90_000)).toBe("1m, 30s");
    expect(formatElapsed(65_000)).toBe("1m, 5s");
  });
  it("shows hours, minutes, and seconds past an hour", () => {
    expect(formatElapsed((1 * 3600 + 3 * 60 + 50) * 1000)).toBe("1h, 3m, 50s");
  });
  it("keeps a zero minutes segment once hours are shown", () => {
    expect(formatElapsed((2 * 3600 + 0 * 60 + 5) * 1000)).toBe("2h, 0m, 5s");
  });
  it("floors sub-second remainders and clamps negatives", () => {
    expect(formatElapsed(1999)).toBe("1s");
    expect(formatElapsed(-5000)).toBe("0s");
  });
});

describe("formatTokenCount", () => {
  it("formats millions", () => {
    expect(formatTokenCount(1024 * 1024)).toBe("1M");
    expect(formatTokenCount(1.5 * 1024 * 1024)).toBe("1.5M");
  });
  it("formats thousands", () => {
    expect(formatTokenCount(256 * 1024)).toBe("256K");
    expect(formatTokenCount(200 * 1024)).toBe("200K");
  });
  it("uses binary K/M, so a 128K window reads as 128K and not 131.1K", () => {
    expect(formatTokenCount(131_072)).toBe("128K");
    expect(formatTokenCount(1_000_000)).toBe("976.6K");
  });
  it("shows a decimal for fractional thousands", () => {
    expect(formatTokenCount(1_260)).toBe("1.2K");
    expect(formatTokenCount(12_640)).toBe("12.3K");
  });
  it("leaves small counts as-is", () => {
    expect(formatTokenCount(512)).toBe("512");
    expect(formatTokenCount(1023)).toBe("1023");
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

describe("cacheSegmentText", () => {
  // The catalog defaults to English; `setLocale` is exercised explicitly below.
  it("shows the session rate before the all-time one", () => {
    expect(cacheSegmentText(0.9, 0.99)).toBe("cache 90% session 99% total");
  });
  it("drops the session half before the first request of a session", () => {
    expect(cacheSegmentText(null, 0.99)).toBe("cache 99% total");
  });
  it("drops the all-time half when the ledger is empty or unread", () => {
    expect(cacheSegmentText(0.9, null)).toBe("cache 90% session");
  });
  it("reads the active locale at call time", () => {
    setLocale("zh-CN");
    try {
      expect(cacheSegmentText(0.9, 0.99)).toBe("缓存 90% 会话 99% 累计");
      expect(cacheSegmentText(null, 0.99)).toBe("缓存 99% 累计");
    } finally {
      setLocale("en");
    }
  });
});

describe("contextBar", () => {
  it("shows sub-cell progress below one cell's worth", () => {
    // Whole-cell flooring left this blank until 10%, so the meter read empty
    // through the whole first tenth of the window.
    expect(contextBar(9)).toBe("▓░░░░░░░░░");
    expect(contextBar(5)).toBe("▒░░░░░░░░░");
  });
  it("lights the faintest rung for any non-zero usage", () => {
    expect(contextBar(0.1)).toBe("▒░░░░░░░░░");
    expect(contextBar(0)).toBe("░░░░░░░░░░");
  });
  it("renders a full bar at 100%", () => {
    expect(contextBar(100)).toBe("██████████");
  });
  it("renders whole cells plus a shaded remainder", () => {
    expect(contextBar(35)).toBe("███▒░░░░░░");
    expect(contextBar(30)).toBe("███░░░░░░░");
  });
  it("clamps out-of-range input", () => {
    expect(contextBar(250)).toBe("██████████");
    expect(contextBar(-5)).toBe("░░░░░░░░░░");
  });
  it("always occupies exactly `width` cells", () => {
    for (const w of [10, 28]) {
      for (let p = 0; p <= 100; p += 0.5) {
        expect([...contextBar(p, w)]).toHaveLength(w);
      }
    }
  });
  it("never leaves part of a cell unpainted", () => {
    // Left-aligned part-blocks (▏▎▍▌▋▊▉) ink only their own sliver and leave
    // the rest of the cell in the terminal background, which beside the dotted
    // track reads as the bar being cut in half at the fill boundary. Every
    // glyph the meter emits must cover its whole cell.
    const inked = new Set(["█", "▓", "▒", "░"]);
    for (const w of [10, 28]) {
      for (let p = 0; p <= 100; p += 0.25) {
        for (const ch of contextBar(p, w)) {
          expect(inked.has(ch)).toBe(true);
        }
      }
    }
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
  it("labels default mode as manual, in light grey", () => {
    expect(permissionModeIndicator("default")).toEqual({
      label: "○ manual mode on",
      color: MODE_MANUAL_HEX,
    });
  });

  it("labels accept-edits, auto, plan, and bypass in distinct colors (hint appended dim by the renderer)", () => {
    expect(permissionModeIndicator("acceptEdits")).toEqual({
      label: "⏵⏵ accept edits on",
      color: MODE_ACCEPT_HEX,
    });
    expect(permissionModeIndicator("auto")).toEqual({
      label: "✦ auto mode on",
      color: MODE_AUTO_HEX,
    });
    expect(permissionModeIndicator("plan")).toEqual({
      label: "⏸ plan mode on",
      color: MODE_PLAN_HEX,
    });
    expect(permissionModeIndicator("bypassPermissions")).toEqual({
      label: "⚠ bypass permissions on",
      color: MODE_BYPASS_HEX,
    });
  });

  it("gives every mode a distinct color and a distinct leading glyph", () => {
    const modes: PermissionMode[] = ["default", "acceptEdits", "auto", "plan", "bypassPermissions"];
    const indicators = modes.map((m) => permissionModeIndicator(m));
    expect(new Set(indicators.map((i) => i.color)).size).toBe(modes.length);
    expect(new Set(indicators.map((i) => i.label.split(" ")[0])).size).toBe(modes.length);
  });
});

describe("shellModeIndicator", () => {
  it("labels shell mode in bash green for the status row", () => {
    expect(shellModeIndicator()).toEqual({ label: "! for shell mode", color: BASH_HEX });
  });
});
