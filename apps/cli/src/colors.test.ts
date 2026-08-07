import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_BADGE_PALETTE, sessionBadgeColor } from "./colors.js";

describe("nested ANSI attributes", () => {
  // `useColor` is decided once, at module load, from FORCE_COLOR/isTTY. Vitest
  // runs with stdout piped (no TTY), so every wrapper would no-op unless colour
  // is forced BEFORE the module is first evaluated — hence the reload per test.
  async function loadColors(): Promise<typeof import("./colors.js")> {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.resetModules();
    return import("./colors.js");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // bold(1) and dim(2) share the closer 22 ("normal intensity"), so without the
  // re-open the inner span's close would strip the outer attribute from
  // everything after it — the bug behind undimmed blockquote tails and table
  // header cells that stopped being bold halfway through.
  it("keeps the outer dim alive after a nested bold ends", async () => {
    const { bold, dim } = await loadColors();
    expect(dim(`a${bold("b")}c`)).toBe("\x1b[2ma\x1b[1mb\x1b[22m\x1b[2mc\x1b[22m");
  });

  it("keeps the outer bold alive after a nested bold ends", async () => {
    const { bold } = await loadColors();
    expect(bold(`a${bold("b")}c`)).toBe("\x1b[1ma\x1b[1mb\x1b[22m\x1b[1mc\x1b[22m");
  });

  // Every foreground colour closes with 39, so colours nest the same way.
  it("keeps the outer colour alive after a nested colour ends", async () => {
    const { cyan, yellow } = await loadColors();
    expect(cyan(`a${yellow("b")}c`)).toBe("\x1b[36ma\x1b[33mb\x1b[39m\x1b[36mc\x1b[39m");
  });

  it("leaves a string with no nested span untouched", async () => {
    const { dim } = await loadColors();
    expect(dim("plain")).toBe("\x1b[2mplain\x1b[22m");
  });
});

describe("headingColor", () => {
  async function loadColors(): Promise<typeof import("./colors.js")> {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("COLORTERM", "truecolor");
    vi.resetModules();
    return import("./colors.js");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Perceived brightness of the truecolor SGR the ramp emitted. */
  const luminance = (s: string): number => {
    // eslint-disable-next-line no-control-regex
    const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(s);
    if (!m) throw new Error(`no truecolor sequence in ${JSON.stringify(s)}`);
    return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
  };

  // Depth is carried by ONE mechanism now. If a future edit reintroduces a hue
  // switch or a bold/dim step for some level, the ramp stops being a ramp.
  it("never brightens as the level goes deeper", async () => {
    const { headingColor } = await loadColors();
    const steps = [1, 2, 3, 4, 5, 6].map((l) => luminance(headingColor(l, "x")));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!).toBeLessThanOrEqual(steps[i - 1]!);
    }
    expect(steps[5]!).toBeLessThan(steps[0]!);
  });

  it("clamps levels outside 1-6 onto the ends of the ramp", async () => {
    const { headingColor } = await loadColors();
    expect(headingColor(0, "x")).toBe(headingColor(1, "x"));
    expect(headingColor(99, "x")).toBe(headingColor(6, "x"));
  });
});

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
