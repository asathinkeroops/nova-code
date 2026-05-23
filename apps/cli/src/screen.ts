import { bold, type Rgb, useTruecolor } from "./colors.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CSI = "\x1b[";

export interface Spinner {
  stop(finalLine?: string): void;
  elapsedMs(): number;
  label(): string;
}

export type SpinnerLabel =
  | string
  | {
      words: string[];
      // Per-char shimmer base color (truecolor required for the wave; falls
      // back to a static tint at brightness 1.0 when unsupported).
      tint?: Rgb;
      // Fallback colorize used when no `tint` is provided.
      colorize?: (word: string) => string;
      intervalMs?: number;
    };

// Sine-modulated per-character brightness gradient that travels left→right
// as `frame` advances. Range [0.45, 1.0] so the dim end stays legible.
function shimmer(text: string, frame: number, [r, g, b]: Rgb): string {
  let out = "\x1b[1m";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === " ") {
      out += ch;
      continue;
    }
    const t = frame * 0.18 - i * 0.32;
    const wave = (Math.sin(t) + 1) / 2;
    const k = 0.45 + 0.55 * wave;
    out += `\x1b[38;2;${Math.round(r * k)};${Math.round(g * k)};${Math.round(b * k)}m${ch}`;
  }
  return out + "\x1b[39m\x1b[22m";
}

// Manages stdout so a footer block (e.g. the todo list) and an optional
// spinner stay pinned to the bottom of the output. Every print() erases
// the sticky region, writes the new content, then redraws the sticky region
// below it — so as output streams, todos slide down with it.
export class Screen {
  private footer: string[] = [];
  private spinnerLine: string | null = null;
  private renderedRows = 0;
  private readonly out = process.stdout;

  private clearSticky(): void {
    if (this.renderedRows === 0) return;
    this.out.write(`${CSI}${this.renderedRows}A\r${CSI}0J`);
    this.renderedRows = 0;
  }

  private renderSticky(): void {
    const lines: string[] = [];
    if (this.spinnerLine !== null) lines.push(this.spinnerLine);
    lines.push(...this.footer);
    if (lines.length === 0) {
      this.renderedRows = 0;
      return;
    }
    this.out.write("\n" + lines.join("\n"));
    this.renderedRows = lines.length;
  }

  print(text: string): void {
    this.clearSticky();
    this.out.write(text);
    this.renderSticky();
  }

  printErr(text: string): void {
    this.clearSticky();
    process.stderr.write(text);
    this.renderSticky();
  }

  setFooter(lines: string[]): void {
    this.clearSticky();
    this.footer = lines;
    this.renderSticky();
  }

  // Erase the current sticky region and stop tracking it, so another
  // renderer (Ink prompt, input box, picker) can draw on the bottom rows
  // without fighting the footer. The footer content is retained — the
  // next print() redraws it at the new bottom.
  detach(): void {
    this.clearSticky();
    this.spinnerLine = null;
  }

  startSpinner(label: SpinnerLabel, hint?: string): Spinner {
    const isTTY = !!this.out.isTTY;
    const start = Date.now();
    let frame = 0;
    let timer: NodeJS.Timeout | null = null;
    const hintStr = hint ? ` · ${hint}` : "";

    const isStatic = typeof label === "string";
    const tint = !isStatic ? label.tint : undefined;
    const colorize = !isStatic && label.colorize ? label.colorize : (s: string) => s;
    const intervalMs = isStatic ? 0 : (label.intervalMs ?? 3000);
    const words = isStatic ? [] : label.words;
    const canShimmer = !!tint && useTruecolor;

    let activeWord: string = isStatic ? label : "";
    let activeAt = 0;

    const rotateIfNeeded = (): void => {
      if (isStatic || words.length === 0) return;
      if (activeWord && Date.now() - activeAt < intervalMs) return;
      let next = words[Math.floor(Math.random() * words.length)] ?? activeWord;
      if (words.length > 1 && activeWord) {
        for (let i = 0; i < 4 && next === activeWord; i++) {
          next = words[Math.floor(Math.random() * words.length)] ?? next;
        }
      }
      activeWord = next;
      activeAt = Date.now();
    };

    rotateIfNeeded();
    const staticRender = (): string => (isStatic ? activeWord : colorize(activeWord));

    const tick = (): void => {
      rotateIfNeeded();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const frameChar = FRAMES[frame % FRAMES.length] ?? "";
      let line: string;
      if (canShimmer && tint) {
        // Render spinner glyph one "step" ahead of the word so the wave
        // appears to flow from the glyph into the text.
        const head = shimmer(frameChar, frame + 1, tint);
        const word = shimmer(activeWord, frame, tint);
        line = `${head} ${word} · ${elapsed}s${hintStr}`;
      } else {
        const renderedFrame = isStatic ? frameChar : bold(colorize(frameChar));
        const word = isStatic ? activeWord : bold(staticRender());
        line = `${renderedFrame} ${word} · ${elapsed}s${hintStr}`;
      }
      this.clearSticky();
      this.spinnerLine = line;
      this.renderSticky();
      frame++;
    };

    if (isTTY) {
      tick();
      timer = setInterval(tick, canShimmer ? 60 : 80);
    } else {
      this.out.write(`… ${staticRender()}${hintStr}\n`);
    }

    return {
      stop: (finalLine?: string): void => {
        if (timer) clearInterval(timer);
        this.clearSticky();
        this.spinnerLine = null;
        if (finalLine) {
          this.out.write(finalLine + "\n");
        }
        this.renderSticky();
      },
      elapsedMs: (): number => Date.now() - start,
      label: (): string => activeWord,
    };
  }
}
