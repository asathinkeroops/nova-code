import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import * as XLSX from "xlsx";

// Secondary safety budget on the size of a single response, measured in JS
// string length (UTF-16 code units ≈ characters), NOT disk bytes. The model-
// facing unit for offset/limit is LINES — far more intuitive than a character
// count — but we still cap the total characters returned so one page can't blow
// up the context. A line that on its own exceeds the budget is truncated to
// MAX_LINE_CHARS with an explicit marker (see the render below) rather than
// returned whole — an unbounded single line (minified bundle, one-line JSON,
// newline-free log) would otherwise blow up the context window.
const MAX_CHARS = 200_000;

// Hard cap on a SINGLE line's text. A line at or under this is returned whole;
// a longer one is truncated with a visible marker so the model knows content was
// dropped — line-based offset/limit can't page *within* one line. Sized well
// above any normal source line (long imports, JSX, inline data stay intact) but
// far below MAX_CHARS, so a pathological line (minified bundle, one-line JSON,
// newline-free log) can't dominate a page or blow up the context.
const MAX_LINE_CHARS = 16_000;

// Width the line number is right-padded to, `cat -n` style. Numbers wider than
// this simply aren't padded (padStart only ever grows a string).
const LINE_NO_WIDTH = 6;

// File extensions recognised as spreadsheet formats that the `xlsx` library can
// parse. Detection is extension-based: fast, unambiguous, and doesn't read the
// file twice.  The list is a subset of what `xlsx` supports — the ones users
// realistically encounter (xls, xlsx, xlsm, xlsb, ods).
const EXCEL_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".xlsb", ".ods"]);

const inputSchema = z.object({
  path: z.string().min(1).describe("Absolute or cwd-relative file path."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "1-based line number to start reading from (default 1). To continue a large file, pass the offset shown in the previous call's truncation note.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Max number of lines to return. The response is also capped at ~${MAX_CHARS} characters; a single line longer than that is truncated with a marker (use grep/sed/bash to read the remainder).`,
    ),
  sheet: z
    .string()
    .optional()
    .describe(
      "For Excel files (.xlsx/.xls/.ods): sheet name or 1-based sheet number. Default: first sheet.",
    ),
});

// ── plain-text path (existing behaviour) ────────────────────────────────────

function renderLines(
  lines: string[],
  total: number,
  startIdx: number,
  endIdx: number,
  path: string,
): string {
  const body = lines
    .slice(startIdx, endIdx)
    .map((line, k) => {
      const lineNo = startIdx + k + 1;
      const n = String(lineNo).padStart(LINE_NO_WIDTH);
      const text = line.endsWith("\n") ? line.slice(0, -1) : line;
      if (text.length > MAX_LINE_CHARS) {
        return `${n}\t${text.slice(0, MAX_LINE_CHARS)} …(line ${lineNo} truncated: showing ${MAX_LINE_CHARS} of ${text.length} chars; offset/limit page by line, not within a line — use grep/sed/bash to read the remainder)`;
      }
      return `${n}\t${text}`;
    })
    .join("\n");

  if (endIdx < total) {
    return `${body}\n…(truncated; showing lines ${startIdx + 1}-${endIdx} of ${total}; continue with read(path="${path}", offset=${endIdx + 1}))`;
  }
  return body;
}

async function readText(abs: string, input: { offset?: number; limit?: number }, path: string) {
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        output: `read failed: no such file: ${path}. It may not exist at this path (or anywhere) — use glob/grep to locate it rather than guessing another path.`,
        isError: true,
      };
    }
    if (code === "EISDIR") {
      return {
        output: `read failed: ${path} is a directory, not a file. Use glob to list its contents or grep to search inside it.`,
        isError: true,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `read failed: ${msg}`, isError: true };
  }

  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const total = lines.length;

  const startLine = input.offset ?? 1;
  const startIdx = startLine - 1;
  if (startIdx >= total && total > 0) {
    return {
      output: `read: offset ${startLine} is past end of file (it has ${total} lines)`,
      isError: true,
    };
  }

  let endIdx = startIdx;
  let chars = 0;
  while (endIdx < total) {
    if (input.limit !== undefined && endIdx - startIdx >= input.limit) break;
    const cost = Math.min(lines[endIdx]!.length, MAX_LINE_CHARS);
    if (chars > 0 && chars + cost > MAX_CHARS) break;
    chars += cost;
    endIdx += 1;
  }

  return { output: renderLines(lines, total, startIdx, endIdx, path) };
}

// ── Excel / spreadsheet path ────────────────────────────────────────────────

/**
 * Resolve a user-supplied `sheet` spec to an actual sheet name.
 * - `undefined` → first sheet
 * - a numeric string like `"2"` → 1-based index
 * - any other string → sheet name (exact match)
 * Returns `null` when the sheet is not found.
 */
function resolveSheet(sheetNames: string[], spec: string | undefined): string | null {
  if (spec === undefined) return sheetNames[0] ?? null;
  const num = Number(spec);
  if (Number.isFinite(num) && String(num) === spec) {
    const idx = num - 1;
    return sheetNames[idx] ?? null;
  }
  return sheetNames.includes(spec) ? spec : null;
}

/**
 * Render a single Excel row as a TSV line.  Cells that contain newlines or tabs
 * are escaped so one row = one output line.
 */
function formatRow(row: unknown[]): string {
  return row
    .map((cell) => {
      if (cell === null || cell === undefined) return "";
      const s = String(cell);
      // Replace literal newlines / tabs with visible placeholders so one row
      // stays exactly one output line and TSV columns stay aligned.
      return s.replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "");
    })
    .join("\t");
}

interface ExcelInput {
  offset?: number;
  limit?: number;
  sheet?: string;
}

async function readExcel(abs: string, input: ExcelInput, path: string) {
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        output: `read failed: no such file: ${path}. It may not exist at this path (or anywhere) — use glob/grep to locate it rather than guessing another path.`,
        isError: true,
      };
    }
    if (code === "EISDIR") {
      return {
        output: `read failed: ${path} is a directory, not a file. Use glob to list its contents or grep to search inside it.`,
        isError: true,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `read failed: ${msg}`, isError: true };
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "buffer" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `read failed: cannot parse ${path} as a spreadsheet: ${msg}`, isError: true };
  }

  const sheetName = resolveSheet(wb.SheetNames, input.sheet);
  if (sheetName === null) {
    return {
      output: `read failed: sheet "${input.sheet ?? "(first)"}" not found. Available sheets: ${wb.SheetNames.map((s) => `"${s}"`).join(", ")}`,
      isError: true,
    };
  }

  const ws = wb.Sheets[sheetName];
  if (!ws) {
    return {
      output: `read failed: sheet "${sheetName}" has no data`,
      isError: true,
    };
  }

  // Convert sheet to array-of-arrays. `header: 1` emits every row verbatim
  // (row 1 = array index 0); `defval: ""` fills missing cells with "" so every
  // row has the same column count.
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  const totalRows = rows.length;
  const numCols = rows.length > 0 ? rows[0]!.length : 0;

  // Build the metadata header line that is always shown.
  const sheetOrdinal = wb.SheetNames.indexOf(sheetName) + 1;
  const sheetCount = wb.SheetNames.length;
  const meta = `Sheet "${sheetName}" (${sheetOrdinal}/${sheetCount} sheet${sheetCount === 1 ? "" : "s"}), ${totalRows} rows × ${numCols} cols`;

  if (totalRows === 0) {
    return { output: meta };
  }

  const startRow = input.offset ?? 1;
  const startIdx = startRow - 1;
  if (startIdx >= totalRows) {
    return {
      output: `read: offset ${startRow} is past end of sheet (it has ${totalRows} rows). ${meta}`,
      isError: true,
    };
  }

  // Select rows within budget (character count is measured on the rendered TSV
  // *before* adding the line-number prefix and potential truncation marker).
  let endIdx = startIdx;
  let chars = 0;
  while (endIdx < totalRows) {
    if (input.limit !== undefined && endIdx - startIdx >= input.limit) break;
    const rendered = formatRow(rows[endIdx]!);
    const cost = Math.min(rendered.length, MAX_LINE_CHARS);
    if (chars > 0 && chars + cost > MAX_CHARS) break;
    chars += cost;
    endIdx += 1;
  }

  // Render: line-number prefix + TSV row, with oversized-line truncation.
  const bodyLines: string[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const rowNo = i + 1;
    const n = String(rowNo).padStart(LINE_NO_WIDTH);
    let rendered = formatRow(rows[i]!);

    if (rendered.length > MAX_LINE_CHARS) {
      rendered = `${rendered.slice(0, MAX_LINE_CHARS)} …(row ${rowNo} truncated: showing ${MAX_LINE_CHARS} of ${rendered.length} chars; use offset/limit to page or bash with a CLI xlsx tool to extract the full row)`;
    }
    bodyLines.push(`${n}\t${rendered}`);
  }

  const body = bodyLines.join("\n");

  // Build the sheet-hint for continuation calls if needed.
  const sheetHint =
    input.sheet !== undefined || wb.SheetNames.length > 1
      ? `, sheet="${sheetName}"`
      : "";

  if (endIdx < totalRows) {
    return {
      output: `${meta}\n${body}\n…(truncated; showing rows ${startIdx + 1}-${endIdx} of ${totalRows}; continue with read(path="${path}", offset=${endIdx + 1}${sheetHint}))`,
    };
  }

  return { output: `${meta}\n${body}` };
}

// ── tool definition ─────────────────────────────────────────────────────────

export const readTool: ToolHandler = {
  definition: {
    name: "read",
    description:
      "Read a text file or spreadsheet from disk. For text files, output is line-numbered (`<line>\\t<text>`, `cat -n` style, 1-based); returns up to `limit` lines (and at most ~200K characters) per call. If more remains, the result tells you the exact read(path, offset) call to continue from. The line-number prefix is display only — strip it before passing text to `edit`. For Excel files (.xlsx/.xls/.xlsm/.xlsb/.ods), each row is rendered as a TSV line with a metadata header; use the optional `sheet` parameter to select a sheet. If you're unsure of the exact path, locate the file with glob/grep first rather than guessing.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    const abs = resolve(ctx.cwd, input.path);
    const ext = extname(abs).toLowerCase();

    if (EXCEL_EXTENSIONS.has(ext)) {
      return readExcel(abs, input, input.path);
    }
    return readText(abs, input, input.path);
  },
};
