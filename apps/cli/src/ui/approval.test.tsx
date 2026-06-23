import { describe, expect, it } from "vitest";
import type { PermissionInput } from "@nova/safety";
import {
  approvalInnerWidth,
  approvalRows,
  clampDetail,
  describeToolInput,
} from "./approval.js";

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

describe("approvalInnerWidth", () => {
  // The modal box's round border (2) + paddingX={1} (2) shrink the wrappable
  // content by 4. Both approvalRows and the ApprovalPrompt render derive their
  // wrap width from this single helper, fed the SAME cols (the viewport's inner
  // width). When the render instead measured against the full terminal width it
  // pre-wrapped the `⎿` body too wide, Ink re-wrapped it, and continuation rows
  // fell back to column 0 — the misalignment this guards against.
  it("subtracts the modal border + padding from the available width", () => {
    expect(approvalInnerWidth(80)).toBe(76);
    expect(approvalInnerWidth(20)).toBe(16);
  });

  it("never drops below 1", () => {
    expect(approvalInnerWidth(2)).toBe(1);
    expect(approvalInnerWidth(0)).toBe(1);
  });
});

describe("approvalRows", () => {
  // Fixed chrome around the detail: border(2) + outer margins(2) + prompt(1) +
  // gap(1) + options marginTop(1) + 3 options = 10, plus the detail's own rows.
  const BASE = 10;

  it("reserves BASE+1 rows for a one-line generic detail (old hardcoded 7 was too small)", () => {
    const rows = approvalRows(permInput("read", { path: "/tmp/x.ts" }), 80);
    expect(rows).toBe(BASE + 1);
    expect(rows).toBeGreaterThan(7);
  });

  it("accounts for wrapping when a generic detail is wider than the terminal", () => {
    // inner width = cols - 4 = 16. A long path wraps onto multiple rows
    // (the "read " tool prefix adds to the same logical line).
    const wide = approvalRows(permInput("read", { path: "/" + "x".repeat(50) }), 20);
    expect(wide).toBeGreaterThan(BASE + 1);
  });

  describe("bash mirrors the message-stream layout (`● bash` header + `⎿` body)", () => {
    it("one-line command: header row + one body row", () => {
      const rows = approvalRows(permInput("bash", { command: "pnpm test" }), 80);
      expect(rows).toBe(BASE + 2);
      expect(rows).toBeGreaterThan(7);
    });

    it("grows by one body row per command line", () => {
      const three = approvalRows(permInput("bash", { command: "a\nb\nc" }), 80);
      expect(three).toBe(BASE + 1 + 3); // header + 3 body rows
    });

    it("wraps long command lines under the `⎿` gutter", () => {
      const wide = approvalRows(permInput("bash", { command: "x".repeat(50) }), 20);
      expect(wide).toBeGreaterThan(BASE + 2);
    });

    it("caps body growth at MAX_DETAIL_LINES and adds a truncated row", () => {
      const huge = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      const rows = approvalRows(permInput("bash", { command: huge }), 80);
      // header(1) + 16 clamped body rows + truncated notice(1).
      expect(rows).toBe(BASE + 1 + 16 + 1);
    });
  });
});
