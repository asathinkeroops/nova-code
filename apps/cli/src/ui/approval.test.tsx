import { describe, expect, it } from "vitest";
import type { PermissionInput } from "@nova/safety";
import { approvalRows, clampDetail, describeToolInput } from "./approval.js";

const permInput = (tool: string, input: Record<string, unknown>): PermissionInput =>
  ({ tool, input }) as unknown as PermissionInput;

describe("describeToolInput", () => {
  it("prefers the salient field per tool", () => {
    expect(describeToolInput({ command: "pnpm test" })).toBe("pnpm test");
    expect(describeToolInput({ path: "/tmp/x.ts", content: "huge..." })).toBe("/tmp/x.ts");
    expect(describeToolInput({ url: "https://example.com" })).toBe("https://example.com");
    expect(describeToolInput({ pattern: "TODO" })).toBe("TODO");
    expect(describeToolInput({ query: "weather" })).toBe("weather");
    expect(describeToolInput({ description: "spawn worker" })).toBe("spawn worker");
  });

  it("picks command before path when both are present", () => {
    expect(describeToolInput({ path: "/x", command: "ls /x" })).toBe("ls /x");
  });

  it("falls back to pretty JSON for unknown shapes", () => {
    const out = describeToolInput({ action: "hover", line: 3 });
    expect(out).toContain('"action": "hover"');
    expect(out).toContain('"line": 3');
  });

  it("ignores blank salient fields", () => {
    expect(describeToolInput({ command: "   ", path: "/real" })).toBe("/real");
  });
});

describe("clampDetail", () => {
  it("passes short text through untouched", () => {
    expect(clampDetail("pnpm test")).toEqual({ text: "pnpm test", truncated: false });
  });

  it("truncates by line count", () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const { text, truncated } = clampDetail(many);
    expect(truncated).toBe(true);
    expect(text.split("\n").length).toBe(16);
  });

  it("truncates by char count", () => {
    const { text, truncated } = clampDetail("x".repeat(5000));
    expect(truncated).toBe(true);
    expect(text.length).toBe(1200);
  });
});

describe("approvalRows", () => {
  // Fixed chrome around the detail: border(2) + outer margins(2) + prompt(1) +
  // gap(1) + options marginTop(1) + 3 options = 10, plus the detail's own rows.
  const BASE = 10;

  it("reserves 11 rows for a one-line detail (the old hardcoded 7 was too small)", () => {
    const rows = approvalRows(permInput("bash", { command: "pnpm test" }), 80);
    expect(rows).toBe(BASE + 1);
    expect(rows).toBeGreaterThan(7);
  });

  it("grows by one row per extra detail line (multi-line input)", () => {
    const three = approvalRows(permInput("bash", { command: "a\nb\nc" }), 80);
    expect(three).toBe(BASE + 3);
  });

  it("accounts for wrapping when the detail is wider than the terminal", () => {
    // inner width = cols - 4 = 16. A 50-char command wraps to ceil(50/16)=4 rows
    // (the "bash " tool prefix adds to the same logical line).
    const wide = approvalRows(permInput("bash", { command: "x".repeat(50) }), 20);
    expect(wide).toBeGreaterThan(BASE + 1);
  });

  it("caps detail growth at MAX_DETAIL_LINES so a huge input can't blow up the modal", () => {
    const huge = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const rows = approvalRows(permInput("bash", { command: huge }), 80);
    // 16 clamped detail lines + 1 truncated-suffix stays on the last line.
    expect(rows).toBe(BASE + 16);
  });
});
