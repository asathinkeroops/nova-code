import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@nova/core";
import * as XLSX from "xlsx";
import { readTool } from "./read.js";

// Mirrors read.ts's MAX_LINE_CHARS. Kept local so the test pins the contract
// rather than re-importing the constant.
const MAX_LINE_CHARS = 16_000;

async function writeFixture(name: string, content: string): Promise<{ cwd: string; path: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "nova-read-"));
  await writeFile(join(cwd, name), content);
  return { cwd, path: name };
}

const ctx = (cwd: string) => ({ cwd }) as unknown as ToolContext;

// ── text-file tests (existing) ──────────────────────────────────────────────

describe("read: single oversized line", () => {
  it("truncates a single line longer than the hard cap and marks it", async () => {
    const lineLen = MAX_LINE_CHARS + 5_000;
    const { cwd, path } = await writeFixture("min.js", "x".repeat(lineLen));

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    // The returned body must be bounded: line prefix + capped text + marker,
    // never the full oversized line.
    expect(res.output.length).toBeLessThan(MAX_LINE_CHARS + 1_000);
    expect(res.output).toContain(`showing ${MAX_LINE_CHARS} of ${lineLen} chars`);
    expect(res.output).toContain("use grep/sed/bash");
    // Exactly MAX_LINE_CHARS of the content survives (the run of x's).
    expect((res.output.match(/x/g) ?? []).length).toBe(MAX_LINE_CHARS);
  });

  it("returns a line at or under the cap whole, with no marker", async () => {
    const { cwd, path } = await writeFixture("ok.js", "y".repeat(MAX_LINE_CHARS));

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    expect(res.output).not.toContain("truncated");
    expect((res.output.match(/y/g) ?? []).length).toBe(MAX_LINE_CHARS);
  });

  it("truncates the oversized first line but still includes the following lines on the page", async () => {
    const big = "z".repeat(MAX_LINE_CHARS + 100);
    const { cwd, path } = await writeFixture("mixed.txt", `${big}\nsecond\nthird\n`);

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.output).toContain("line 1 truncated");
    // The budget charges the truncated cost, so the small tail still fits the
    // same page rather than spilling into a continuation read.
    expect(res.output).toContain("second");
    expect(res.output).toContain("third");
    expect(res.output).not.toContain("continue with read");
  });
});

// ── Excel-read tests ────────────────────────────────────────────────────────

/**
 * Write a minimal .xlsx workbook to a temp dir and return the fixture info.
 */
async function writeXlsxFixture(
  name: string,
  rows: unknown[][],
  opts?: { sheetName?: string; extraSheet?: { name: string; rows: unknown[][] } },
): Promise<{ cwd: string; path: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "nova-read-xlsx-"));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, opts?.sheetName ?? "Sheet1");
  if (opts?.extraSheet) {
    const ws2 = XLSX.utils.aoa_to_sheet(opts.extraSheet.rows);
    XLSX.utils.book_append_sheet(wb, ws2, opts.extraSheet.name);
  }
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  await writeFile(join(cwd, name), buf);
  return { cwd, path: name };
}

describe("read: Excel files", () => {
  it("reads a simple .xlsx with metadata header", async () => {
    const { cwd, path } = await writeXlsxFixture("data.xlsx", [
      ["Name", "Age"],
      ["Alice", 30],
      ["Bob", 25],
    ]);

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    expect(res.output).toContain('Sheet "Sheet1" (1/1 sheet), 3 rows × 2 cols');
    expect(res.output).toContain("Name");
    expect(res.output).toContain("Alice");
    expect(res.output).toContain("Bob");
  });

  it("selects a sheet by name", async () => {
    const { cwd, path } = await writeXlsxFixture(
      "multi.xlsx",
      [["A"]],
      {
        sheetName: "First",
        extraSheet: { name: "Second", rows: [["B"]] },
      },
    );

    const res = await readTool.run({ path, sheet: "Second" }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    expect(res.output).toContain('Sheet "Second"');
    expect(res.output).toContain("B");
    expect(res.output).not.toContain("A");
  });

  it("selects a sheet by 1-based index", async () => {
    const { cwd, path } = await writeXlsxFixture(
      "multi.xlsx",
      [["first"]],
      {
        sheetName: "S1",
        extraSheet: { name: "S2", rows: [["second"]] },
      },
    );

    const res = await readTool.run({ path, sheet: "2" }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("second");
    expect(res.output).not.toContain("first");
  });

  it("errors when sheet is not found", async () => {
    const { cwd, path } = await writeXlsxFixture("single.xlsx", [["X"]]);

    const res = await readTool.run({ path, sheet: "Ghost" }, ctx(cwd));

    expect(res.isError).toBe(true);
    expect(res.output).toContain("not found");
    expect(res.output).toContain("Sheet1");
  });

  it("errors for non-existent file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-read-xlsx-"));
    const res = await readTool.run({ path: "nope.xlsx" }, ctx(cwd));

    expect(res.isError).toBe(true);
    expect(res.output).toContain("no such file");
  });

  it("respects offset and limit", async () => {
    const rows = [
      ["H1", "H2"],
      ["R1", "A"],
      ["R2", "B"],
      ["R3", "C"],
      ["R4", "D"],
    ];
    const { cwd, path } = await writeXlsxFixture("large.xlsx", rows);

    const res = await readTool.run({ path, offset: 3, limit: 2 }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    // metadata, rows 3 and 4
    expect(res.output).toContain("R2");
    expect(res.output).toContain("R3");
    // rows 1, 2, 5 should not be visible
    expect(res.output).not.toContain("R1");
    expect(res.output).not.toContain("R4");
    expect(res.output).toContain("continue with read");
  });

  it("handles empty sheet gracefully", async () => {
    const { cwd, path } = await writeXlsxFixture("empty.xlsx", []);

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("0 rows");
  });

  it("escapes newlines and tabs in cells", async () => {
    const { cwd, path } = await writeXlsxFixture("esc.xlsx", [
      ["Col1", "Col2"],
      ["line1\nline2", "tab\there"],
    ]);

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("line1\\nline2");
    expect(res.output).toContain("tab\\there");
  });

  it("falls back to text read for .csv files (not Excel)", async () => {
    const { cwd, path } = await writeFixture("data.csv", "a,b,c\n1,2,3\n");

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    // csv is NOT in the Excel extension set → treated as plain text
    expect(res.output).toContain("a,b,c");
    expect(res.output).toContain("1,2,3");
  });
});
