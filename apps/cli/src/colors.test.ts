import { describe, expect, it } from "vitest";
import { SESSION_BADGE_PALETTE, sessionBadgeColor } from "./colors.js";

describe("sessionBadgeColor", () => {
  it("always returns a colour from the palette", () => {
    for (const name of ["api", "frontend", "bug-123", "实验窗口", ""]) {
      expect(SESSION_BADGE_PALETTE).toContain(sessionBadgeColor(name));
    }
  });

  it("is deterministic for a given name", () => {
    expect(sessionBadgeColor("payments")).toBe(sessionBadgeColor("payments"));
  });

  it("ignores surrounding whitespace (same colour as the trimmed name)", () => {
    expect(sessionBadgeColor("  payments  ")).toBe(sessionBadgeColor("payments"));
  });

  it("spreads distinct names across most of the palette", () => {
    const names = Array.from({ length: 50 }, (_, i) => `session-${i}`);
    const used = new Set(names.map(sessionBadgeColor));
    // A reasonable hash should hit a good fraction of the buckets.
    expect(used.size).toBeGreaterThanOrEqual(Math.ceil(SESSION_BADGE_PALETTE.length / 2));
  });
});
