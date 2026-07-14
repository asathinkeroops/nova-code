import { describe, expect, it } from "vitest";
import {
  formatDuration,
  nextCronFire,
  parseCron,
  parseDuration,
  parseSchedule,
} from "./parse.js";

describe("parseDuration", () => {
  it("parses s/m/h units into milliseconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration(" 2m ")).toBe(120_000);
  });

  it("rejects bare numbers, zero, unknown units, and junk", () => {
    expect(parseDuration("5")).toBeNull();
    expect(parseDuration("0s")).toBeNull();
    expect(parseDuration("10ms")).toBeNull();
    expect(parseDuration("5d")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("-3m")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("renders the compact unit form", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(300_000)).toBe("5m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(90_000)).toBe("90s");
  });
});

describe("parseSchedule", () => {
  it("treats interval tokens as intervals", () => {
    expect(parseSchedule("5m")).toEqual({ kind: "interval", intervalMs: 300_000 });
    expect(parseSchedule(" 1h ")).toEqual({ kind: "interval", intervalMs: 3_600_000 });
  });

  it("treats a valid 5-field expression as cron, collapsing whitespace", () => {
    expect(parseSchedule("0   9 * * *")).toEqual({ kind: "cron", expr: "0 9 * * *" });
  });

  it("rejects junk and wrong-arity expressions", () => {
    expect(parseSchedule("5")).toBeNull();
    expect(parseSchedule("0 9 * *")).toBeNull(); // 4 fields
    expect(parseSchedule("nonsense here now")).toBeNull();
    expect(parseSchedule("")).toBeNull();
  });
});

describe("parseCron", () => {
  it("parses stars, numbers, ranges, steps, and lists", () => {
    const f = parseCron("*/15 0-6 1,15 * 1-5")!;
    expect(f).not.toBeNull();
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...f.hour].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...f.dom].sort((a, b) => a - b)).toEqual([1, 15]);
    expect(f.month.size).toBe(12);
    expect([...f.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(f.domRestricted).toBe(true);
    expect(f.dowRestricted).toBe(true);
  });

  it("normalizes day-of-week 7 to 0 (Sunday)", () => {
    const f = parseCron("0 0 * * 7")!;
    expect([...f.dow]).toEqual([0]);
  });

  it("records which day fields are unrestricted", () => {
    const f = parseCron("0 0 * * *")!;
    expect(f.domRestricted).toBe(false);
    expect(f.dowRestricted).toBe(false);
  });

  it("rejects out-of-range values and malformed fields", () => {
    expect(parseCron("60 * * * *")).toBeNull(); // minute max 59
    expect(parseCron("* 24 * * *")).toBeNull(); // hour max 23
    expect(parseCron("* * 0 * *")).toBeNull(); // dom min 1
    expect(parseCron("* * * 13 *")).toBeNull(); // month max 12
    expect(parseCron("* * * * 8")).toBeNull(); // dow max 7
    expect(parseCron("5-1 * * * *")).toBeNull(); // inverted range
    expect(parseCron("*/0 * * * *")).toBeNull(); // zero step
    expect(parseCron("a * * * *")).toBeNull();
    expect(parseCron("* * * *")).toBeNull(); // arity
  });
});

describe("nextCronFire", () => {
  it("finds the next daily 09:00", () => {
    const f = parseCron("0 9 * * *")!;
    // From 08:30 → same day 09:00.
    expect(nextCronFire(f, new Date(2026, 0, 1, 8, 30, 30).getTime())).toBe(
      new Date(2026, 0, 1, 9, 0).getTime(),
    );
    // From 09:30 → next day 09:00.
    expect(nextCronFire(f, new Date(2026, 0, 1, 9, 30, 0).getTime())).toBe(
      new Date(2026, 0, 2, 9, 0).getTime(),
    );
  });

  it("honors */15 minute steps", () => {
    const f = parseCron("*/15 * * * *")!;
    expect(nextCronFire(f, new Date(2026, 0, 1, 8, 7, 30).getTime())).toBe(
      new Date(2026, 0, 1, 8, 15).getTime(),
    );
  });

  it("rolls over month boundaries", () => {
    const f = parseCron("0 0 1 * *")!; // first of month, midnight
    expect(nextCronFire(f, new Date(2026, 0, 15, 12, 0, 0).getTime())).toBe(
      new Date(2026, 1, 1, 0, 0).getTime(),
    );
  });

  it("applies the DOM/DOW OR-rule (either day field matches)", () => {
    const f = parseCron("0 0 13 * 5")!; // 13th OR Friday
    // From Thu Jan 1 noon → next Friday (Jan 2) beats the 13th.
    expect(nextCronFire(f, new Date(2026, 0, 1, 12, 0, 0).getTime())).toBe(
      new Date(2026, 0, 2, 0, 0).getTime(),
    );
    // From Fri Jan 9 noon → the 13th (Tue) beats next Friday (Jan 16).
    expect(nextCronFire(f, new Date(2026, 0, 9, 12, 0, 0).getTime())).toBe(
      new Date(2026, 0, 13, 0, 0).getTime(),
    );
  });

  it("returns null for an impossible expression within the horizon", () => {
    const f = parseCron("0 0 30 2 *")!; // Feb 30 never exists
    expect(nextCronFire(f, new Date(2026, 0, 1, 0, 0, 0).getTime())).toBeNull();
  });
});
