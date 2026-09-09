import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ART_PRESETS,
  encodeArtSpans,
  renderArtModule,
  type ArtSpan,
  type RawImage,
} from "./art-sampler.js";
import { DEEPSEEK_ART, DEEPSEEK_ART_WIDTH } from "./deepseek-art.js";
import { GLM_ART, GLM_ART_WIDTH } from "./glm-art.js";
import { MOONSHOT_ART, MOONSHOT_ART_WIDTH } from "./moonshot-art.js";

/** Rebuild the sampled bitmap from spans: one pixel per cell half. */
function spansToImage(spans: ArtSpan[][], width: number): RawImage {
  const height = spans.length * 2;
  const data = new Uint8Array(width * height * 3);
  const put = (x: number, y: number, hex: string): void => {
    const offset = (y * width + x) * 3;
    data[offset] = parseInt(hex.slice(1, 3), 16);
    data[offset + 1] = parseInt(hex.slice(3, 5), 16);
    data[offset + 2] = parseInt(hex.slice(5, 7), 16);
  };
  for (const [y, row] of spans.entries()) {
    let x = 0;
    for (const [fg, bg, count] of row) {
      for (let i = 0; i < count; i++, x++) {
        put(x, y * 2, fg);
        put(x, y * 2 + 1, bg);
      }
    }
  }
  return { data, width, height, channels: 3 };
}

const CHECKED_IN = [
  { name: "deepseek", spans: DEEPSEEK_ART, width: DEEPSEEK_ART_WIDTH },
  { name: "moonshot", spans: MOONSHOT_ART, width: MOONSHOT_ART_WIDTH },
  { name: "glm", spans: GLM_ART, width: GLM_ART_WIDTH },
] as const;

describe("checked-in arts", () => {
  // The sampler must be able to reproduce every art byte for byte — otherwise
  // re-running the script on a refreshed logo would produce a spurious diff.
  for (const { name, spans, width } of CHECKED_IN) {
    const preset = ART_PRESETS[name];
    if (!preset) throw new Error(`missing preset for ${name}`);

    it(`${name}: re-encodes to the same spans`, () => {
      const image = spansToImage(spans, width);
      expect(encodeArtSpans(image, preset)).toEqual(spans);
    });

    it(`${name}: renders the checked-in module verbatim`, () => {
      const file = readFileSync(new URL(`./${preset.file}`, import.meta.url), "utf8");
      expect(renderArtModule(name, preset, spans)).toBe(file);
    });
  }
});

describe("encodeArtSpans", () => {
  const opts = { width: 4, rows: 1, snapWhite: 248, snapBlack: 8 };

  /** A 4×2 RGB image from per-cell [top, bottom] pairs. */
  function image(cells: Array<[string, string]>): RawImage {
    const data = new Uint8Array(4 * 2 * 3);
    const put = (x: number, y: number, hex: string): void => {
      const offset = (y * 4 + x) * 3;
      data[offset] = parseInt(hex.slice(1, 3), 16);
      data[offset + 1] = parseInt(hex.slice(3, 5), 16);
      data[offset + 2] = parseInt(hex.slice(5, 7), 16);
    };
    cells.forEach(([top, bottom], x) => {
      put(x, 0, top);
      put(x, 1, bottom);
    });
    return { data, width: 4, height: 2, channels: 3 };
  }

  it("merges runs of identical cells", () => {
    const spans = encodeArtSpans(
      image([
        ["#ffffff", "#ffffff"],
        ["#ffffff", "#ffffff"],
        ["#131212", "#131212"],
        ["#131212", "#131212"],
      ]),
      opts,
    );
    expect(spans).toEqual([
      [
        ["#ffffff", "#ffffff", 2],
        ["#131212", "#131212", 2],
      ],
    ]);
  });

  it("snaps near-white to pure white and near-black to pure black", () => {
    const spans = encodeArtSpans(
      image([
        ["#fbfbfb", "#f8f8f8"],
        ["#070707", "#020202"],
        ["#f0f0f0", "#101010"],
        ["#abcdef", "#123456"],
      ]),
      opts,
    );
    expect(spans[0]).toEqual([
      ["#ffffff", "#ffffff", 1],
      ["#000000", "#000000", 1],
      ["#f0f0f0", "#101010", 1],
      ["#abcdef", "#123456", 1],
    ]);
  });

  it("rejects an image that is not width × rows*2", () => {
    expect(() => encodeArtSpans(image([]), { ...opts, width: 5 })).toThrow(/expected a 5×2 image/);
  });
});
