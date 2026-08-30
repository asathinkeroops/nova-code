import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import type { ImageBlock, ToolFollowupMessage, ToolHandler } from "@nova/core";
import type { Sharp } from "sharp";
import type * as XLSX from "xlsx";
import { extractText } from "unpdf";
import { fileExecutionKey } from "./file-execution.js";
import { PATH_ALIASES, withAliases } from "./schema.js";

/**
 * `xlsx` costs ~57ms to evaluate and is pulled in by `@nova/tools`' entry point,
 * so every `nova` launch paid for it whether or not a spreadsheet was ever read.
 * Loaded on first use instead; the module cache makes repeat reads free. Only
 * the types are imported statically (erased at compile time).
 *
 * `unpdf` measures ~3ms — it defers its own heavy work — so it stays eager.
 */
let xlsxModule: typeof XLSX | null = null;

async function loadXlsx(): Promise<typeof XLSX> {
  xlsxModule ??= await import("xlsx");
  return xlsxModule;
}

// `sharp` loads a native image-processing library, so keep it off the CLI's
// startup path and pay that cost only when read actually receives an image.
// Node's module loader caches the dynamic import for subsequent image reads.
async function loadSharp() {
  const { default: sharp } = await import("sharp");
  return sharp;
}

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

// KB/MB are binary here (1 KB = 1024 bytes), matching the CLI's own byte
// formatter and what `ls -lh` / Finder report for the same file.
const KB = 1024;
const MB = 1024 * 1024;

// Max file size for PDF reads (30 MB). unpdf loads and parses the whole document
// into memory before any pagination applies, so a byte cap guards against a
// pathological PDF exhausting memory; output is still bounded by MAX_CHARS/limit.
const MAX_PDF_BYTES = 30 * MB;

// ── image support ────────────────────────────────────────────────────────────

/** File extensions that the model API can consume as image blocks. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Provider-neutral maximum for either image dimension. */
const MAX_IMAGE_DIMENSION = 1_568;

/** Magic bytes for verifying that a file's content matches its extension. */
const IMAGE_MAGIC: Record<string, readonly number[]> = {
  ".png": [0x89, 0x50, 0x4e, 0x47],
  ".jpg": [0xff, 0xd8, 0xff],
  ".jpeg": [0xff, 0xd8, 0xff],
  ".gif": [0x47, 0x49, 0x46],
  ".webp": [0x52, 0x49, 0x46, 0x46],
};

/** Extension -> MIME type for the model API's `media_type` field. */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// `withAliases` lets the model name the path field `filePath`/`file_path`/`file`
// instead of `path` without failing validation — a frequent DeepSeek slip,
// especially on paginated reads. See packages/tools/src/schema.ts for the why.
const inputSchema = withAliases(
  z.object({
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
  }),
  { path: PATH_ALIASES },
);

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

// Line-based pagination shared by the plain-text and PDF readers: split an
// already-loaded string into lines, honour offset/limit, cap the total at
// MAX_CHARS, and render `cat -n`-style with a continuation note. Used verbatim
// for text files; the PDF reader prepends its own metadata header to the output.
function paginateLines(raw: string, input: { offset?: number; limit?: number }, path: string) {
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

  // Binary guard: a file that decodes to text containing NUL bytes is not real
  // source (images without a known extension, PDFs, compiled artifacts, archives).
  // Reading it as UTF-8 yields line-numbered mojibake that pollutes context and
  // burns tokens, so refuse with guidance instead. NUL never appears in genuine
  // text; check a leading window so a huge binary is caught without scanning it all.
  if (raw.slice(0, 65_536).includes("\u0000")) {
    return {
      output: `read failed: ${path} appears to be a binary file (contains NUL bytes). read handles text, spreadsheets, and images; use bash (e.g. \`file\`, \`xxd\`, \`hexdump -C\`) to inspect binary content.`,
      isError: true,
    };
  }

  return paginateLines(raw, input, path);
}

// ── PDF path ─────────────────────────────────────────────────────────────────

async function readPdf(abs: string, input: { offset?: number; limit?: number }, path: string) {
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

  if (buf.length > MAX_PDF_BYTES) {
    const mb = (buf.length / MB).toFixed(1);
    const cap = (MAX_PDF_BYTES / MB).toFixed(0);
    return {
      output: `read failed: ${path} is ${mb} MB (PDF cap is ${cap} MB). Use bash with a command-line tool (e.g. \`pdftotext\`, \`qpdf\`) to split or extract it.`,
      isError: true,
    };
  }

  let totalPages: number;
  let pages: string[];
  try {
    // extractText internally builds a document proxy from the raw bytes; a fresh
    // Uint8Array copy avoids handing pdf.js a Buffer view it may retain/detach.
    const extracted = await extractText(new Uint8Array(buf), { mergePages: false });
    totalPages = extracted.totalPages;
    pages = extracted.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `read failed: cannot parse ${path} as a PDF: ${msg}`, isError: true };
  }

  const meta = `PDF "${basename(path)}" — ${totalPages} page${totalPages === 1 ? "" : "s"}`;

  // A PDF with no extractable text is almost always scanned/image-only; the text
  // reader would return an empty body with no hint, so say so explicitly.
  if (pages.every((p) => p.trim() === "")) {
    return {
      output: `${meta}\nread: no extractable text — this PDF is likely scanned or image-only. Use bash with an OCR tool (e.g. \`ocrmypdf\`, \`tesseract\`) to extract its text.`,
    };
  }

  // Join pages with a visible `[Page N]` marker so the model can cite locations;
  // the markers count as body lines, which is fine — offset/limit page by line.
  const combined = pages.map((p, i) => `[Page ${i + 1}]\n${p.trim()}`).join("\n\n");
  const result = paginateLines(combined, input, path);
  if (result.isError) return result;
  return { output: `${meta}\n${result.output}` };
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

  const xlsx = await loadXlsx();
  let wb: XLSX.WorkBook;
  try {
    wb = xlsx.read(buf, { type: "buffer" });
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
  const rows: unknown[][] = xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });
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
    input.sheet !== undefined || wb.SheetNames.length > 1 ? `, sheet="${sheetName}"` : "";

  if (endIdx < totalRows) {
    return {
      output: `${meta}\n${body}\n…(truncated; showing rows ${startIdx + 1}-${endIdx} of ${totalRows}; continue with read(path="${path}", offset=${endIdx + 1}${sheetHint}))`,
    };
  }

  return { output: `${meta}\n${body}` };
}

// ── image path ───────────────────────────────────────────────────────────────

function checkMagic(buf: Buffer, ext: string): boolean {
  const magic = IMAGE_MAGIC[ext];
  if (!magic) return true; // unknown extension — let it through
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
}

interface PreparedImage {
  buffer: Buffer;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  resized: boolean;
}

function encodeForExtension(image: Sharp, ext: string): Sharp {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return image.jpeg();
    case ".gif":
      return image.gif();
    case ".webp":
      return image.webp();
    default:
      return image.png();
  }
}

/** Scale oversized images down to fit the dimension cap without cropping. */
async function prepareImage(buf: Buffer, ext: string): Promise<PreparedImage> {
  try {
    const sharp = await loadSharp();
    const animated = ext === ".gif" || ext === ".webp";
    const options = { animated, limitInputPixels: false } as const;
    const metadata = await sharp(buf, options).metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.pageHeight ?? metadata.height;

    if (originalWidth === undefined || originalHeight === undefined) {
      return { buffer: buf, originalWidth, originalHeight, resized: false };
    }

    if (Math.max(originalWidth, originalHeight) <= MAX_IMAGE_DIMENSION) {
      return {
        buffer: buf,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        resized: false,
      };
    }

    const scale = MAX_IMAGE_DIMENSION / Math.max(originalWidth, originalHeight);
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const source = sharp(buf, options).autoOrient();
    // For multi-frame images sharp exposes the frames as a vertical stack.
    // Width-only resize applies the same scale to every frame; passing the
    // per-frame height here would instead squash the whole stack.
    const image = animated
      ? source.resize({ width, withoutEnlargement: true })
      : source.resize({ width, height, fit: "fill", withoutEnlargement: true });
    const result = await encodeForExtension(image, ext).toBuffer({ resolveWithObject: true });
    return {
      buffer: result.data,
      originalWidth,
      originalHeight,
      width,
      height,
      resized: true,
    };
  } catch {
    // Preserve the previous pass-through behaviour for truncated or unusual
    // images that the provider may still accept.
    return { buffer: buf, resized: false };
  }
}

async function readImage(
  abs: string,
  ext: string,
  path: string,
): Promise<{
  output: string;
  isError?: boolean;
  followupMessages?: ToolFollowupMessage[];
}> {
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

  // Verify magic bytes match the extension; if not, the file is mislabeled.
  // Still serve it — the API will reject a wrong media_type, but that's better
  // than silently sending garbled text from the text-reader fallback.
  const magicOk = checkMagic(buf, ext);
  const mediaType = (IMAGE_MIME[ext] ?? "image/png") as ImageBlock["source"]["media_type"];

  const prepared = await prepareImage(buf, ext);
  const base64 = prepared.buffer.toString("base64");
  const sizeKB = (prepared.buffer.length / KB).toFixed(1);

  let output = `Image: ${path}\n  format: ${ext.slice(1).toUpperCase()}${mediaType ? ` (${mediaType})` : ""}, ${sizeKB} KB`;
  if (prepared.resized) {
    output += `\n  dimensions: ${prepared.originalWidth}×${prepared.originalHeight} → ${prepared.width}×${prepared.height} (proportionally resized; max dimension ${MAX_IMAGE_DIMENSION}px)`;
  } else if (prepared.width !== undefined && prepared.height !== undefined) {
    output += `\n  dimensions: ${prepared.width}×${prepared.height}`;
  }
  if (!magicOk) {
    output += `\n  ⚠ magic bytes do not match ${ext} extension — file may be mislabeled`;
  }

  const block: ImageBlock = {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: base64 },
  };

  const followup: ToolFollowupMessage = { role: "user", content: [block] };
  return { output, followupMessages: [followup] };
}

// ── tool definition ─────────────────────────────────────────────────────────

export const readTool: ToolHandler = {
  definition: {
    name: "read",
    description:
      "Read a text file, spreadsheet, PDF, or image from disk. For text files, output is line-numbered (`<line>\\t<text>`, `cat -n` style, 1-based); returns up to `limit` lines (and at most ~200K characters) per call. If more remains, the result tells you the exact read(path, offset) call to continue from. The line-number prefix is display only — strip it before passing text to `edit`. For Excel files (.xlsx/.xls/.xlsm/.xlsb/.ods), each row is rendered as a TSV line with a metadata header; use the optional `sheet` parameter to select a sheet. For PDF files (.pdf), extracted text is returned line-numbered with a `[Page N]` marker before each page and the same offset/limit paging; scanned/image-only PDFs have no extractable text (capped at 30 MB). For image files (.png/.jpg/.jpeg/.gif/.webp), returns text metadata plus a base64 user-image message — only when the active model supports image input; dimensions over 1568px are proportionally resized before return.",
    inputSchema,
  },
  executionKey: fileExecutionKey,
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    const abs = resolve(ctx.cwd, input.path);
    const ext = extname(abs).toLowerCase();

    // Image: when the model supports images, read as a provider-neutral
    // follow-up user message. The loop appends it after the tool_result batch.
    // When it does NOT, refuse with guidance rather than falling through to the
    // text reader — decoding an image (or any binary) as UTF-8 yields tens of
    // thousands of lines of line-numbered mojibake that pollute the context and
    // burn tokens for nothing (a real regression seen on image-less tiers).
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (ctx.modelModalities?.input.includes("image")) {
        return readImage(abs, ext, input.path);
      }
      return {
        output: `read failed: ${input.path} is an image (${ext}), but the active model tier does not accept image input. Switch to an image-capable tier (e.g. /model pro or max) to read it, or use bash (e.g. \`file\`, \`sips -g pixelWidth -g pixelHeight\`) to inspect it.`,
        isError: true,
      };
    }

    if (EXCEL_EXTENSIONS.has(ext)) {
      return readExcel(abs, input, input.path);
    }
    if (ext === ".pdf") {
      return readPdf(abs, input, input.path);
    }
    return readText(abs, input, input.path);
  },
};
