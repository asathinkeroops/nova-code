/**
 * Re-sample a provider wordmark into the first-run setup panel's block art.
 *
 * The generated modules (`src/ui/{glm,deepseek,moonshot}-art.ts`) are checked
 * in — no image decoder ships with the CLI, so the art is never computed at
 * runtime. This script is the offline half: decode the logo with sharp, resize
 * it to the sampler's cell grid, and rewrite the module. `src/ui/art-sampler.ts`
 * owns the encode/render logic and the per-provider presets; its unit tests
 * round-trip the checked-in arts through the same code, so re-running this
 * script on an unchanged logo is a no-op.
 *
 * Usage (from the repo root):
 *   pnpm --filter @asathinkeroops/nova-code sample-art --preset glm --input ~/zhipu-logo.png
 *   pnpm --filter @asathinkeroops/nova-code sample-art --preset glm --input ... --dry-run
 *
 * Options:
 *   --preset <name>      glm | deepseek | moonshot            (default: glm)
 *   --input <path>       source image                          (default: the preset's recorded filename, resolved in cwd)
 *   --out <path>         output module                         (default: src/ui/<preset.file>)
 *   --fit <fit>          sharp resize fit: fill|cover|contain  (default: fill)
 *   --kernel <kernel>    sharp resize kernel                   (default: lanczos3)
 *   --background <hex>   backdrop for transparent pixels       (default: the preset's card color)
 *   --dry-run            print the module instead of writing it
 *   --help               show this help
 *
 * `fill` is the default because the checked-in arts are sampled edge to edge
 * with no letterboxing: the wordmark is stretched to the cell grid rather than
 * cropped (cover) or padded (contain). Pass `--fit contain --background ...`
 * for a source that is not tightly cropped.
 */

import { access, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { ART_PRESETS, encodeArtSpans, renderArtModule } from "../src/ui/art-sampler.js";

const FITS = ["fill", "cover", "contain"] as const;
type Fit = (typeof FITS)[number];

const KERNELS = [
  "nearest",
  "cubic",
  "linear",
  "mitchell",
  "lanczos2",
  "lanczos3",
  "mks2013",
  "mks2021",
] as const;
type Kernel = (typeof KERNELS)[number];

const USAGE = `Usage: pnpm --filter @asathinkeroops/nova-code sample-art [options]

  --preset <name>      ${Object.keys(ART_PRESETS).join(" | ")}   (default: glm)
  --input <path>       source image (default: the preset's recorded filename, in cwd)
  --out <path>         output module (default: src/ui/<preset.file>)
  --fit <fit>          ${FITS.join("|")}   (default: fill)
  --kernel <kernel>    ${KERNELS.join("|")}   (default: lanczos3)
  --background <hex>   backdrop for transparent pixels (default: the preset's card color)
  --dry-run            print the module instead of writing it
  --help               show this help
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      preset: { type: "string", default: "glm" },
      input: { type: "string" },
      out: { type: "string" },
      fit: { type: "string", default: "fill" },
      kernel: { type: "string", default: "lanczos3" },
      background: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const presetName = values.preset;
  const preset = ART_PRESETS[presetName];
  if (!preset) {
    fail(
      `unknown preset "${presetName}" — expected one of: ${Object.keys(ART_PRESETS).join(", ")}`,
    );
  }

  const fit = values.fit as Fit;
  if (!FITS.includes(fit)) {
    fail(`unknown --fit "${values.fit}" — expected one of: ${FITS.join(", ")}`);
  }
  const kernel = values.kernel as Kernel;
  if (!KERNELS.includes(kernel)) {
    fail(`unknown --kernel "${values.kernel}" — expected one of: ${KERNELS.join(", ")}`);
  }

  const inputPath = resolve(values.input ?? preset.source);
  try {
    await access(inputPath);
  } catch {
    fail(`source image not found: ${inputPath}\nPass --input <path> (see --help).`);
  }

  const height = preset.rows * 2;
  const { data, info } = await sharp(inputPath)
    // Flatten BEFORE resizing: transparent pixels must take the card color
    // first, or the resample would blend their edges toward black.
    .flatten({ background: values.background ?? preset.background })
    .resize({ width: preset.width, height, fit, kernel })
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3 && info.channels !== 4) {
    fail(`expected an RGB(A) sample after flattening, got ${info.channels} channel(s)`);
  }

  const spans = encodeArtSpans(
    { data, width: info.width, height: info.height, channels: info.channels },
    preset,
  );
  const text = renderArtModule(presetName, preset, spans);
  const cellCount = spans.reduce((n, row) => n + row.length, 0);

  if (values["dry-run"]) {
    process.stdout.write(text);
    return;
  }

  const outPath = values.out
    ? resolve(values.out)
    : fileURLToPath(new URL(`../src/ui/${preset.file}`, import.meta.url));
  const previous = await readFile(outPath, "utf8").catch(() => null);
  if (previous === text) {
    process.stdout.write(
      `${outPath}: unchanged (${basename(inputPath)} → ${preset.width}×${height}, ${cellCount} spans)\n`,
    );
    return;
  }
  await writeFile(outPath, text, "utf8");
  process.stdout.write(
    `${outPath}: ${previous === null ? "written" : "updated"} ` +
      `(${basename(inputPath)} → ${preset.width}×${height}, ${cellCount} spans)\n`,
  );
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
