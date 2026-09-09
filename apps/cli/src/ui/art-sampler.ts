/**
 * Offline sampler behind the first-run setup panel's block art
 * (`glm-art.ts`, `deepseek-art.ts`, `moonshot-art.ts`).
 *
 * Each terminal cell collapses two pixel rows into `▀`: the top pixel is the
 * cell's foreground, the bottom pixel its background. Runs of identical cells
 * merge into `[fgHex, bgHex, count]` spans, which is what the generated modules
 * export and their views render.
 *
 * Pure by design — no image decoder here. `apps/cli/scripts/sample-art.ts`
 * decodes and resizes the source with sharp and calls {@link encodeArtSpans};
 * keeping the encode/render half decoder-free is what lets the unit tests
 * round-trip the checked-in arts through it.
 */

/** One run of identical cells: [topPixelHex, bottomPixelHex, repeatCount]. */
export type ArtSpan = [fg: string, bg: string, count: number];

export interface ArtPreset {
  /** Generated module's basename under `src/ui/`. */
  file: string;
  /** Exported array name; `<exportName>_WIDTH` is emitted alongside it. */
  exportName: string;
  /** Source image filename recorded in the generated header. */
  source: string;
  /** Cells per terminal row. */
  width: number;
  /** Terminal rows; the sampler consumes `rows * 2` pixel rows. */
  rows: number;
  /**
   * Snap a pixel to `#ffffff` when every channel is at least this. Calibrated
   * above the brightest non-white value in the checked-in art, so re-running the
   * script on the same source reproduces it unchanged.
   */
  snapWhite?: number;
  /** Snap a pixel to `#000000` when every channel is at most this. */
  snapBlack?: number;
  /** Backdrop for transparent source pixels, applied before resizing. */
  background: string;
}

/**
 * Per-provider sampling parameters. The header text is part of the preset so a
 * regenerated file reads exactly like the checked-in one (same wording, same
 * line breaks) — the art modules are reviewed as prose as much as data.
 */
export const ART_PRESETS: Record<string, ArtPreset> = {
  deepseek: {
    file: "deepseek-art.ts",
    exportName: "DEEPSEEK_ART",
    source: "logo.png",
    width: 76,
    rows: 8,
    snapWhite: 248,
    background: "#ffffff",
  },
  moonshot: {
    file: "moonshot-art.ts",
    exportName: "MOONSHOT_ART",
    source: "moonshot.png",
    width: 76,
    rows: 8,
    snapWhite: 248,
    snapBlack: 8,
    background: "#000000",
  },
  glm: {
    file: "glm-art.ts",
    exportName: "GLM_ART",
    source: "zhipu-logo.png",
    width: 76,
    rows: 8,
    snapWhite: 248,
    background: "#ffffff",
  },
};

/** Preset-specific header sentences, keyed by preset name. */
const HEADERS: Record<string, (source: string) => string[]> = {
  deepseek: (source) => [
    `// Auto-generated from the DeepSeek wordmark (${source}), sampled to`,
    "// upper-half-block cells: each span is [fgHex, bgHex, count] where fg is the top",
    "// pixel and bg the bottom pixel of a `▀` run. Near-white pixels are snapped to",
    "// pure white, so the mark sits on a faithful white card. Regenerated offline; not",
    "// computed at runtime (no image decoder ships).",
  ],
  moonshot: (source) => [
    `// Auto-generated from the Moonshot (Kimi) wordmark (${source}), sampled to`,
    "// upper-half-block cells: each span is [fgHex, bgHex, count] where fg is the top",
    "// pixel and bg the bottom pixel of a `▀` run. The wordmark is pure white, so it",
    "// sits on a black card (unlike the blue-on-white DeepSeek mark). Near-black and",
    "// near-white pixels are snapped to exact endpoints for a clean card. Regenerated",
    "// offline; not computed at runtime (no image decoder ships).",
  ],
  glm: (source) => [
    `// Auto-generated from the Zhipu (GLM) wordmark (${source}), sampled to`,
    "// upper-half-block cells: each span is [fgHex, bgHex, count] where fg is the top",
    "// pixel and bg the bottom pixel of a `▀` run. The mark is dark gray on white, so",
    "// near-white pixels are snapped to pure white and the card stays white (unlike",
    "// the white-on-black Moonshot mark). Regenerated offline; not computed at",
    "// runtime (no image decoder ships).",
  ],
};

/** A raw, already-resized image: `channels` bytes per pixel, row-major. */
export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  /** Bytes per pixel — 3 (RGB) or 4 (RGBA). */
  channels: number;
}

/** What {@link encodeArtSpans} reads off a preset. */
export type SamplerOptions = Pick<ArtPreset, "width" | "rows" | "snapWhite" | "snapBlack">;

const WHITE = "#ffffff";
const BLACK = "#000000";

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** One pixel snapped to a card endpoint when the preset asks for it. */
function snapPixel(image: RawImage, offset: number, opts: SamplerOptions): string {
  const r = image.data[offset] ?? 0;
  const g = image.data[offset + 1] ?? 0;
  const b = image.data[offset + 2] ?? 0;
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  if (opts.snapBlack !== undefined && max <= opts.snapBlack) return BLACK;
  if (opts.snapWhite !== undefined && min >= opts.snapWhite) return WHITE;
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Encode a `width × rows*2` image into one span row per terminal row. The image
 * must already be opaque (the script flattens transparency onto the preset's
 * background) and exactly the requested size.
 */
export function encodeArtSpans(image: RawImage, opts: SamplerOptions): ArtSpan[][] {
  const expectedHeight = opts.rows * 2;
  if (image.width !== opts.width || image.height !== expectedHeight) {
    throw new Error(
      `expected a ${opts.width}×${expectedHeight} image, got ${image.width}×${image.height}`,
    );
  }
  const rows: ArtSpan[][] = [];
  for (let y = 0; y < opts.rows; y++) {
    const spans: ArtSpan[] = [];
    for (let x = 0; x < opts.width; x++) {
      const top = snapPixel(image, (y * 2 * opts.width + x) * image.channels, opts);
      const bottom = snapPixel(image, ((y * 2 + 1) * opts.width + x) * image.channels, opts);
      const last = spans[spans.length - 1];
      if (last && last[0] === top && last[1] === bottom) last[2]++;
      else spans.push([top, bottom, 1]);
    }
    rows.push(spans);
  }
  return rows;
}

/**
 * Render the generated module exactly as checked in: preset header, the shared
 * `BlockSpan` type, the width constant, then one compact JSON row per line with
 * a trailing comma (prettier's `trailingComma: all`).
 */
export function renderArtModule(presetName: string, preset: ArtPreset, spans: ArtSpan[][]): string {
  const header = HEADERS[presetName];
  if (!header) throw new Error(`no header template for preset "${presetName}"`);
  const rows = spans.map((row) => `  ${JSON.stringify(row)},`);
  return [
    ...header(preset.source),
    "export type BlockSpan = [fg: string, bg: string, count: number];",
    `export const ${preset.exportName}_WIDTH = ${preset.width};`,
    `export const ${preset.exportName}: BlockSpan[][] = [`,
    ...rows,
    "];",
    "",
  ].join("\n");
}
