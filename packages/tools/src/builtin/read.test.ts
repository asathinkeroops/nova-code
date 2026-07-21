import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@nova/core";
import * as XLSX from "xlsx";
import { readTool } from "./read.js";

// Mirrors read.ts's MAX_LINE_CHARS. Kept local so the test pins the contract
// rather than re-importing the constant.
const MAX_LINE_CHARS = 16_000;
const MAX_IMAGE_BYTES = 20_000_000;

async function writeFixture(name: string, content: string): Promise<{ cwd: string; path: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "nova-read-"));
  await writeFile(join(cwd, name), content);
  return { cwd, path: name };
}

/** Write a binary buffer to a temp file. */
async function writeBinaryFixture(name: string, buf: Buffer): Promise<{ cwd: string; path: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "nova-read-"));
  await writeFile(join(cwd, name), buf);
  return { cwd, path: name };
}

/** A minimal valid PNG header (signature + IHDR chunk with CRC). */
function minimalPngBytes(): Buffer {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR: 1x1 8-bit RGB
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  // compression=0, filter=0, interlace=0 (already zero-filled)

  const ihdrType = Buffer.from("IHDR");
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrCrc = crc32(Buffer.concat([ihdrType, ihdrData]));
  const ihdrCrcBuf = Buffer.alloc(4);
  ihdrCrcBuf.writeUInt32BE(ihdrCrc, 0);

  // IDAT: minimal zlib-compressed 1x1 RGB pixel (red = FF 00 00, filtered with 0)
  // zlib header (78 01), raw deflate: 63 60 60 F8 4F 00 00 04 00 01, adler32
  const idatRaw = Buffer.from([0x78, 0x01, 0x63, 0x60, 0x60, 0xf8, 0x4f, 0x00, 0x00, 0x04, 0x00, 0x01]);
  const idatType = Buffer.from("IDAT");
  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(idatRaw.length, 0);
  const idatCrc = crc32(Buffer.concat([idatType, idatRaw]));
  const idatCrcBuf = Buffer.alloc(4);
  idatCrcBuf.writeUInt32BE(idatCrc, 0);

  // IEND
  const iendType = Buffer.from("IEND");
  const iendLen = Buffer.alloc(4);
  iendLen.writeUInt32BE(0, 0);
  const iendCrc = crc32(iendType);
  const iendCrcBuf = Buffer.alloc(4);
  iendCrcBuf.writeUInt32BE(iendCrc, 0);

  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, ihdrCrcBuf, idatLen, idatType, idatRaw, idatCrcBuf, iendLen, iendType, iendCrcBuf]);
}

/** Minimal JPEG bytes: SOI marker (FF D8 FF) + dummy data. */
function minimalJpegBytes(): Buffer {
  // SOI marker + APP0 marker header + minimal payload
  const soi = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  // APP0 length = 16
  const len = Buffer.alloc(2);
  len.writeUInt16BE(16, 0);
  const jfif = Buffer.from("JFIF\0");
  const ver = Buffer.from([1, 1]); // version 1.1
  const units = Buffer.from([0]); // no units
  const density = Buffer.alloc(4); // zero density
  const thumb = Buffer.from([0, 0]); // no thumbnail
  const app0 = Buffer.concat([len, jfif, ver, units, density, thumb]);
  // SOS marker
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  // EOI marker
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sos, eoi]);
}

const ctx = (cwd: string, opts?: { modelModalities?: { input: readonly ("text" | "image")[] } }) =>
  ({ cwd, ...opts }) as unknown as ToolContext;

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

// ── image-read tests ─────────────────────────────────────────────────────────

describe("read: image files", () => {
  it("returns an image block when the model accepts images (PNG)", async () => {
    const { cwd, path } = await writeBinaryFixture("test.png", minimalPngBytes());

    const res = await readTool.run(
      { path },
      ctx(cwd, { modelModalities: { input: ["text", "image"] } }),
    );

    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("Image:");
    expect(res.output).toContain("test.png");
    expect(res.output).toContain("PNG");
    expect(res.output).toContain("image/png");
    expect(res.blocks).toHaveLength(1);
    const block = res.blocks![0]!;
    expect(block.type).toBe("image");
    if (block.type === "image") {
      expect(block.source.type).toBe("base64");
      expect(block.source.media_type).toBe("image/png");
      expect(block.source.data).toBeTruthy();
    }
  });

  it("returns an image block for JPEG", async () => {
    const { cwd, path } = await writeBinaryFixture("photo.jpeg", minimalJpegBytes());

    const res = await readTool.run(
      { path },
      ctx(cwd, { modelModalities: { input: ["text", "image"] } }),
    );

    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("image/jpeg");
    expect(res.blocks).toHaveLength(1);
    const block = res.blocks![0]!;
    if (block.type === "image") {
      expect(block.source.media_type).toBe("image/jpeg");
    }
  });

  it("returns an image block for .jpg extension", async () => {
    const { cwd, path } = await writeBinaryFixture("photo.jpg", minimalJpegBytes());

    const res = await readTool.run(
      { path },
      ctx(cwd, { modelModalities: { input: ["text", "image"] } }),
    );

    expect(res.isError).toBeUndefined();
    expect(res.blocks).toHaveLength(1);
    const block = res.blocks![0]!;
    if (block.type === "image") {
      expect(block.source.media_type).toBe("image/jpeg");
    }
  });

  it("refuses (does NOT dump binary) when the model does NOT support images", async () => {
    const { cwd, path } = await writeBinaryFixture("test.png", minimalPngBytes());

    const res = await readTool.run(
      { path },
      ctx(cwd, { modelModalities: { input: ["text"] } }),
    );

    // Must NOT fall through to the text reader and dump line-numbered mojibake:
    // an image on a text-only tier is an actionable error, not content.
    expect(res.blocks).toBeUndefined();
    expect(res.isError).toBe(true);
    expect(res.output).toContain("image");
    expect(res.output).not.toContain("PNG\r\n"); // no raw bytes in the output
  });

  it("refuses an image when modelModalities is undefined", async () => {
    const { cwd, path } = await writeBinaryFixture("test.png", minimalPngBytes());

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.blocks).toBeUndefined();
    expect(res.isError).toBe(true);
    expect(res.output).toContain("image");
  });

  it("refuses a binary file with NUL bytes instead of dumping mojibake", async () => {
    // A binary blob without an image extension still reaches the text reader;
    // the NUL-byte guard must catch it rather than line-numbering the bytes.
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x42]);
    const { cwd, path } = await writeBinaryFixture("blob.bin", bytes);

    const res = await readTool.run(
      { path },
      ctx(cwd, { modelModalities: { input: ["text"] } }),
    );

    expect(res.blocks).toBeUndefined();
    expect(res.isError).toBe(true);
    expect(res.output).toContain("binary");
  });

  it("rejects an oversized image", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-read-"));
    const filePath = join(cwd, "big.png");
    // Write a file with valid PNG magic but claimed size > MAX_IMAGE_BYTES.
    // We write a sparse file via seeking — but writeFile writes actual bytes.
    // Instead, just write a buffer slightly over the limit.
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const large = Buffer.alloc(MAX_IMAGE_BYTES + 1); // 1 byte over
    sig.copy(large);
    await writeFile(filePath, large);

    const res = await readTool.run(
      { path: "big.png" },
      ctx(cwd, { modelModalities: { input: ["text", "image"] } }),
    );

    expect(res.isError).toBe(true);
    expect(res.output).toContain("MB");
    expect(res.blocks).toBeUndefined();
  });

  it("warns on magic-byte mismatch but still returns the image", async () => {
    // A .png file whose content starts with JPEG magic → mismatch
    const jpegBytes = minimalJpegBytes();
    const { cwd, path } = await writeBinaryFixture("fake.png", jpegBytes);

    const res = await readTool.run(
      { path },
      ctx(cwd, { modelModalities: { input: ["text", "image"] } }),
    );

    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("magic bytes do not match");
    // Still returns a block — the caller decides what to do
    expect(res.blocks).toHaveLength(1);
  });

  it("reads .webp and .gif extensions", async () => {
    // GIF magic: 47 49 46
    const gifBuf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
    const gifFixture = await writeBinaryFixture("anim.gif", gifBuf);
    const gifRes = await readTool.run(
      { path: gifFixture.path },
      ctx(gifFixture.cwd, { modelModalities: { input: ["text", "image"] } }),
    );
    expect(gifRes.blocks).toHaveLength(1);
    const gifBlock = gifRes.blocks![0]!;
    if (gifBlock.type === "image") {
      expect(gifBlock.source.media_type).toBe("image/gif");
    }

    // WebP magic: 52 49 46 46
    const webpBuf = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]); // RIFF....WEBP
    const webpFixture = await writeBinaryFixture("img.webp", webpBuf);
    const webpRes = await readTool.run(
      { path: webpFixture.path },
      ctx(webpFixture.cwd, { modelModalities: { input: ["text", "image"] } }),
    );
    expect(webpRes.blocks).toHaveLength(1);
    const webpBlock = webpRes.blocks![0]!;
    if (webpBlock.type === "image") {
      expect(webpBlock.source.media_type).toBe("image/webp");
    }
  });

  it("does not treat .svg as image (model can't consume SVG as image block)", async () => {
    const { cwd, path } = await writeFixture(
      "icon.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>',
    );

    const res = await readTool.run(
      { path },
      ctx(cwd, { modelModalities: { input: ["text", "image"] } }),
    );

    // SVG is NOT in IMAGE_EXTENSIONS → treated as text
    expect(res.blocks).toBeUndefined();
    expect(res.output).toContain("svg");
  });

  it("errors for a non-existent image file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-read-"));
    const res = await readTool.run(
      { path: "nope.png" },
      ctx(cwd, { modelModalities: { input: ["text", "image"] } }),
    );

    expect(res.isError).toBe(true);
    expect(res.output).toContain("no such file");
  });
});

// ── PDF tests ───────────────────────────────────────────────────────────────

/**
 * Build a minimal single-page PDF whose content stream draws `text`. The xref
 * byte offsets are computed so pdf.js parses it without falling back to recovery
 * mode. Pass "" for a page with no drawn text (mimics a scanned/image-only PDF).
 */
function minimalPdfBytes(text: string): Buffer {
  const streamContent = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

describe("read: PDF files", () => {
  it("extracts text with a metadata header and a page marker", async () => {
    const { cwd, path } = await writeBinaryFixture("doc.pdf", minimalPdfBytes("Hello Nova"));

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    expect(res.blocks).toBeUndefined();
    expect(res.output).toContain('PDF "doc.pdf" — 1 page');
    expect(res.output).toContain("[Page 1]");
    expect(res.output).toContain("Hello Nova");
    // Line-numbered like the text reader (cat -n prefix on the marker line).
    expect(res.output).toMatch(/\s+1\t\[Page 1\]/);
  });

  it("reports no extractable text for a scanned/image-only PDF", async () => {
    const { cwd, path } = await writeBinaryFixture("scan.pdf", minimalPdfBytes(""));

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.isError).toBeUndefined();
    expect(res.output).toContain('PDF "scan.pdf" — 1 page');
    expect(res.output).toContain("no extractable text");
    expect(res.output).toContain("OCR");
  });

  it("errors on a file that is not a valid PDF", async () => {
    const { cwd, path } = await writeBinaryFixture(
      "broken.pdf",
      Buffer.from("this is definitely not a pdf"),
    );

    const res = await readTool.run({ path }, ctx(cwd));

    expect(res.isError).toBe(true);
    expect(res.output).toContain("cannot parse");
  });

  it("errors for a non-existent PDF file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-read-"));

    const res = await readTool.run({ path: "nope.pdf" }, ctx(cwd));

    expect(res.isError).toBe(true);
    expect(res.output).toContain("no such file");
  });
});
