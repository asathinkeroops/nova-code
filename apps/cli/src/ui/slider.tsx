import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { accent, bold, dim, rgbFg, type Rgb, useColor, useTruecolor } from "../colors.js";
import { UI_FRAME_MS } from "./frame.js";
import { countWrappedLines } from "./measure.js";
import { overlayBorderProps } from "./picker.js";
import { visibleWidth } from "./width.js";

/**
 * A horizontal "effort slider": the items are laid out left→right along a rule,
 * captioned with a `leftLabel` (Faster) / `rightLabel` (Smarter) gradient, an
 * arrow marker (▲) parked on the rule above the highlighted item, and an
 * optional description line for the current selection below the row. Purpose-
 * built for `/effort` — a labelled 1-D scale reads better than the plain
 * button row {@link PickHorizontal} draws. Returns the chosen item, or null on
 * escape.
 */
export interface SliderPickerOptions<T> {
  items: T[];
  /** Plain label for each item; the selected one is highlighted automatically. */
  label: (item: T) => string;
  /** Optional description for an item, shown below the row and updated live. */
  description?: (item: T) => string;
  /** Caption at the fast/low end of the scale (defaults to "Faster"). */
  leftLabel?: string;
  /** Caption at the smart/high end of the scale (defaults to "Smarter"). */
  rightLabel?: string;
  /**
   * Optional per-item accent (truecolor RGB) painted on the highlighted label
   * and the arrow marker — e.g. a cool→warm gradient across the scale. Falls
   * back to the UI accent when unset or when the terminal lacks truecolor.
   */
  tint?: (item: T) => Rgb | undefined;
  /**
   * Optional per-item flag: when the highlighted item returns true (and the
   * terminal supports truecolor), its label and marker animate as a shifting
   * rainbow instead of a static {@link tint} — a "this is the extreme setting"
   * flourish. Drives a repaint timer only while such an item is selected.
   */
  shimmer?: (item: T) => boolean;
  /** Optional footer line shown below everything. */
  footer?: string;
  /** Initial highlighted index (defaults to 0). */
  initialIndex?: number;
  /**
   * When set, draw a single top rule in this color above the slider (the 弹层
   * chrome shared with {@link PickList}) and span the panel's inner width.
   * Unset renders the bare slider with no chrome.
   */
  topRuleColor?: string;
}

/** Columns between adjacent item labels along the track. */
const SEP = 3;

/** HSL→RGB (h in [0,360), s/l in [0,1]) → 0–255 triple, for the rainbow cycle. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

/**
 * Paint `text` as a rainbow whose hue sweeps across the glyphs and drifts with
 * `frame`, giving an animated multi-colour shimmer. Spaces pass through so the
 * cycling is confined to the visible label.
 */
function rainbow(text: string, frame: number): string {
  let out = "\x1b[1m";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === " ") {
      out += ch;
      continue;
    }
    const [r, g, b] = hslToRgb(frame * 12 + i * 38, 1, 0.62);
    out += `\x1b[38;2;${r};${g};${b}m${ch}`;
  }
  return out + "\x1b[39m\x1b[22m";
}

/**
 * Geometry of the track: the total width of the item row and the center column
 * (within that row) of each item, both measured in plain — pre-colour — columns
 * so the arrow marker lands dead-centre over its label regardless of styling.
 */
export function trackGeometry(labels: string[]): { width: number; centers: number[] } {
  const centers: number[] = [];
  let col = 0;
  labels.forEach((lbl, i) => {
    if (i > 0) col += SEP;
    const w = visibleWidth(lbl);
    centers.push(col + Math.floor(w / 2));
    col += w;
  });
  return { width: col, centers };
}

interface SliderPickerProps<T> {
  opts: SliderPickerOptions<T>;
  onResolve: (value: T | null) => void;
  /**
   * Width the top-rule panel spans — the viewport's inner (H_PAD-inset) width.
   * Falls back to the terminal width so the component still renders standalone.
   */
  panelWidth?: number;
}

export function SliderPicker<T>({ opts, onResolve, panelWidth }: SliderPickerProps<T>): React.ReactElement {
  const items = opts.items;
  const initialIndex = Math.min(Math.max(0, opts.initialIndex ?? 0), Math.max(0, items.length - 1));
  const { stdout } = useStdout();
  const [selected, setSelected] = useState(initialIndex);
  const [frame, setFrame] = useState(0);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onResolve(null);
      return;
    }
    if (key.return) {
      onResolve(items[selected] ?? null);
      return;
    }
    if (key.leftArrow || (key.ctrl && input === "b") || input === "h") {
      setSelected((s) => (s - 1 + items.length) % items.length);
      return;
    }
    if (key.rightArrow || (key.ctrl && input === "f") || input === "l") {
      setSelected((s) => (s + 1) % items.length);
      return;
    }
    if (key.ctrl && input === "a") {
      setSelected(0);
      return;
    }
    if (key.ctrl && input === "e") {
      setSelected(items.length - 1);
      return;
    }
  });

  // Paint the highlight (selected label + arrow): a live rainbow when the current
  // item opts into shimmer, else its static tint, else the plain UI accent. Both
  // colour paths need truecolor; without it we fall back to bold-accent so the
  // choice still reads. `animating` gates the repaint timer so it only runs while
  // a shimmering item is selected.
  const selectedItem = items[selected] as T;
  const tint = opts.tint?.(selectedItem);
  const animating = useColor && useTruecolor && !!opts.shimmer?.(selectedItem);
  const paintHighlight = (text: string): string => {
    if (!useColor) return text;
    if (animating) return rainbow(text, frame);
    if (tint && useTruecolor) return bold(rgbFg(tint, text));
    return bold(accent(text));
  };

  useEffect(() => {
    if (!animating) return;
    const id = setInterval(() => setFrame((f) => f + 1), UI_FRAME_MS);
    return () => clearInterval(id);
  }, [animating]);

  const labels = items.map((it) => opts.label(it));
  const { width, centers } = trackGeometry(labels);
  const leftLabel = opts.leftLabel ?? "Faster";
  const rightLabel = opts.rightLabel ?? "Smarter";
  // The item row (and the rule above it) start one column past the left caption,
  // so the caption sits to the left of the scale and the labels line up under
  // the rule. The right caption trails the rule by the same gap.
  const indent = visibleWidth(leftLabel) + 1;
  const arrowCol = centers[selected] ?? 0;

  // Scale line: caption + rule with the arrow parked over the selected item +
  // caption. The rule is dim; the marker takes the highlight colour so the eye
  // jumps to it (and shimmers along with a rainbow item).
  const rule =
    dim("─".repeat(arrowCol)) +
    paintHighlight("▲") +
    dim("─".repeat(Math.max(0, width - arrowCol - 1)));
  const scaleLine = `${bold(leftLabel)} ${rule}  ${bold(rightLabel)}`;

  // Item row, indented to align under the rule. The selected label takes the
  // highlight colour, the rest are dimmed. When colour is off the arrow alone
  // marks the choice.
  const cells: string[] = [];
  labels.forEach((lbl, i) => {
    if (i > 0) cells.push(" ".repeat(SEP));
    cells.push(i === selected ? paintHighlight(lbl) : dim(lbl));
  });
  const itemLine = " ".repeat(indent) + cells.join("");

  const description = opts.description?.(items[selected] as T);

  // Optional purple top rule spanning the panel's inner width, matching the
  // list/status overlays. Bare (no chrome) when topRuleColor is unset.
  const fullWidth = !!opts.topRuleColor;
  const cols = panelWidth ?? stdout?.columns ?? 80;
  const borderProps = overlayBorderProps(false, opts.topRuleColor);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      {...(fullWidth ? { width: cols } : {})}
      {...borderProps}
    >
      <Text>{scaleLine}</Text>
      <Text>{itemLine}</Text>
      {description ? (
        <>
          <Text> </Text>
          <Text>{dim(description)}</Text>
        </>
      ) : null}
      {opts.footer ? (
        <>
          <Text> </Text>
          <Text>{opts.footer}</Text>
        </>
      ) : null}
    </Box>
  );
}

/**
 * Exact render height of {@link SliderPicker}: top/bottom margin, the scale rule
 * and item rows, plus the (wrap-aware) description and footer with their leading
 * spacer rows. The description is sized to the tallest item so the reserved
 * height never shrinks as the selection moves.
 */
export function sliderRows<T>(opts: SliderPickerOptions<T>, cols: number): number {
  const inner = Math.max(1, cols); // top-rule panel spans the full inner width
  let n = 2; // top + bottom margin
  if (opts.topRuleColor) n += 1; // top rule
  n += 1 + 1; // scale line + item row
  if (opts.description) {
    const tallest = Math.max(
      1,
      ...opts.items.map((it) => countWrappedLines(opts.description!(it), inner)),
    );
    n += 1 + tallest; // spacer + description
  }
  if (opts.footer) n += 1 + countWrappedLines(opts.footer, inner); // spacer + footer
  return n;
}
