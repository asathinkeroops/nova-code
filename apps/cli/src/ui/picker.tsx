import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { ACCENT_HEX, accent, diffTint, dim, useColor } from "../colors.js";
import { applyInverse } from "./selection.js";
import { visibleWidth } from "./width.js";

/**
 * Paint a full-width selection bar behind `text`: right-pad with spaces to
 * `width` visible columns, then lay the drag-selection background across the
 * whole line so the highlight spans the entire row, not just its glyphs.
 * Reusing `applyInverse` keeps picker selection and text selection the same
 * colour and preserves any foreground colours already in `text`.
 */
export function highlightRow(text: string, width: number): string {
  const tw = visibleWidth(text);
  const padded = tw < width ? text + " ".repeat(width - tw) : text;
  return applyInverse(padded, 0, Math.max(width, tw));
}

export interface PickerOptions<T> {
  items: T[];
  /** Rendered once per row; `selected` is true for the highlighted item. */
  render: (item: T, selected: boolean) => string;
  /** Optional header line shown above the list. */
  header?: string;
  /** Optional footer line shown below the list. */
  footer?: string;
  /** Max rows shown at once; longer lists scroll with the selection. */
  pageSize?: number;
  /** Initial highlighted index (defaults to 0). */
  initialIndex?: number;
  /** Draw the round border around the list. Defaults to true. */
  border?: boolean;
}

interface PickListProps<T> {
  opts: PickerOptions<T>;
  onResolve: (value: T | null) => void;
}

function clampWindow(selected: number, count: number, pageSize: number): number {
  let start = 0;
  if (selected >= pageSize) start = selected - pageSize + 1;
  const maxStart = Math.max(0, count - pageSize);
  if (start > maxStart) start = maxStart;
  if (start < 0) start = 0;
  return start;
}

export function PickList<T>({ opts, onResolve }: PickListProps<T>): React.ReactElement {
  const items = opts.items;
  const pageSize = Math.max(1, opts.pageSize ?? 10);
  const initialIndex = Math.min(Math.max(0, opts.initialIndex ?? 0), Math.max(0, items.length - 1));
  const [selected, setSelected] = useState(initialIndex);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onResolve(null);
      return;
    }
    if (key.return) {
      onResolve(items[selected] ?? null);
      return;
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      setSelected((s) => (s - 1 + items.length) % items.length);
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
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

  const windowStart = clampWindow(selected, items.length, pageSize);
  const end = Math.min(items.length, windowStart + pageSize);

  const indicator =
    items.length > pageSize
      ? useColor
        ? dim(`  (${selected + 1}/${items.length})`)
        : `  (${selected + 1}/${items.length})`
      : null;

  // Render the visible rows once, then size a full-width selection bar to the
  // widest rendered line (rows plus header/footer/indicator, which also drive
  // the box width) so the highlighted row spans the whole list, not just its
  // glyphs. Skip the bar entirely when colour is off — the arrow still marks
  // the selection and we'd otherwise emit raw escape codes.
  const rendered: string[] = [];
  for (let i = windowStart; i < end; i++) {
    rendered.push(opts.render(items[i] as T, i === selected));
  }
  const barWidth = Math.max(
    0,
    ...rendered.map(visibleWidth),
    opts.header ? visibleWidth(opts.header) : 0,
    opts.footer ? visibleWidth(opts.footer) : 0,
    indicator ? visibleWidth(indicator) : 0,
  );
  const rows: React.ReactNode[] = [];
  for (let i = windowStart; i < end; i++) {
    const text = rendered[i - windowStart] as string;
    const body = i === selected && useColor ? highlightRow(text, barWidth) : text;
    rows.push(<Text key={i}>{body}</Text>);
  }

  const bordered = opts.border ?? true;
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      {...(bordered ? { borderStyle: "round" as const } : {})}
    >
      {opts.header ? <Text>{opts.header}</Text> : null}
      {rows}
      {indicator ? <Text>{indicator}</Text> : null}
      {opts.footer ? <Text>{opts.footer}</Text> : null}
    </Box>
  );
}

/** Convenience helper to colour the selection arrow consistently. */
export const pickerArrow = (selected: boolean): string =>
  selected ? accent("❯") : " ";

export interface ViewerLine {
  /** The line body, already coloured (sign, syntax highlighting, etc.). */
  text: string;
  /** Optional full-width background tint, painted across the body only. */
  bg?: "add" | "del";
  /** Optional fixed prefix (e.g. a line-number gutter) drawn outside the tint. */
  gutter?: string;
}

export interface ViewerOptions {
  /** The content, one entry per line. Plain strings render with no tint. */
  lines: Array<string | ViewerLine>;
  /** Optional header line shown above the content. */
  header?: string;
  /** Optional footer line shown below the content. */
  footer?: string;
  /** Max lines shown at once; longer content scrolls. Defaults to 20. */
  pageSize?: number;
  /** Draw the round border around the viewer. Defaults to true. */
  border?: boolean;
}

/** Full rendered text of a viewer line (gutter + body), for width/height measurement. */
export function viewerLineText(line: string | ViewerLine): string {
  return typeof line === "string" ? line : (line.gutter ?? "") + line.text;
}

interface ScrollViewerProps {
  opts: ViewerOptions;
  onResolve: (value: null) => void;
}

/**
 * Width for the full-width diff tint bar: the widest visible body, capped to
 * the space left on the row (terminal columns minus the round border and the
 * widest gutter). The cap matters because the gutter is drawn outside the tint,
 * so an uncapped bar sized to one long line (e.g. README prose) would push
 * `gutter + bar` past the terminal edge and make Ink wrap every shorter row's
 * trailing padding onto a blank continuation line.
 */
export function tintBarWidth(visible: ViewerLine[], cols: number, bordered: boolean): number {
  const gutterW = Math.max(0, ...visible.map((l) => visibleWidth(l.gutter ?? "")));
  const avail = Math.max(1, cols - (bordered ? 2 : 0) - gutterW);
  return Math.min(avail, Math.max(0, ...visible.map((l) => visibleWidth(l.text))));
}

/**
 * Pad `text` to `width` visible columns and paint a full-width diff tint across
 * it, so the add/remove highlight spans the whole row rather than just glyphs.
 */
function tintRow(text: string, width: number, kind: "add" | "del"): string {
  const tw = visibleWidth(text);
  const padded = tw < width ? text + " ".repeat(width - tw) : text;
  return diffTint(kind, padded);
}

/**
 * A read-only, scrollable text pager. Unlike {@link PickList} there is no
 * per-line highlight — content scrolls by line (↑↓ / j k), by page (PgUp/PgDn /
 * space), or jumps to ends (g / G); any confirm/quit key (enter / esc / q)
 * closes it. Used by `/diff` to page through a single file's patch.
 */
export function ScrollViewer({ opts, onResolve }: ScrollViewerProps): React.ReactElement {
  const lines: ViewerLine[] = opts.lines.map((l) =>
    typeof l === "string" ? { text: l } : l,
  );
  const pageSize = Math.max(1, opts.pageSize ?? 20);
  const maxStart = Math.max(0, lines.length - pageSize);
  const [start, setStart] = useState(0);
  const { stdout } = useStdout();
  const clamp = (n: number): number => Math.min(maxStart, Math.max(0, n));

  useInput((input, key) => {
    if (key.escape || key.return || input === "q" || (key.ctrl && input === "c")) {
      onResolve(null);
      return;
    }
    if (key.downArrow || input === "j" || (key.ctrl && input === "n")) {
      setStart((s) => clamp(s + 1));
    } else if (key.upArrow || input === "k" || (key.ctrl && input === "p")) {
      setStart((s) => clamp(s - 1));
    } else if (key.pageDown || input === " " || (key.ctrl && input === "f")) {
      setStart((s) => clamp(s + pageSize));
    } else if (key.pageUp || (key.ctrl && input === "b")) {
      setStart((s) => clamp(s - pageSize));
    } else if (input === "g" || (key.ctrl && input === "a")) {
      setStart(0);
    } else if (input === "G" || (key.ctrl && input === "e")) {
      setStart(maxStart);
    }
  });

  const end = Math.min(lines.length, start + pageSize);
  const visible = lines.slice(start, end);
  const bordered = opts.border ?? true;
  const barWidth = tintBarWidth(visible, stdout?.columns ?? 80, bordered);
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < visible.length; i++) {
    const line = visible[i] as ViewerLine;
    const body = line.bg && useColor ? tintRow(line.text, barWidth, line.bg) : line.text;
    rows.push(<Text key={start + i}>{(line.gutter ?? "") + body}</Text>);
  }

  const indicator =
    lines.length > pageSize
      ? useColor
        ? dim(`  (${start + 1}–${end}/${lines.length})`)
        : `  (${start + 1}–${end}/${lines.length})`
      : null;

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      {...(bordered ? { borderStyle: "round" as const } : {})}
    >
      {opts.header ? <Text>{opts.header}</Text> : null}
      {rows}
      {indicator ? <Text>{indicator}</Text> : null}
      {opts.footer ? <Text>{opts.footer}</Text> : null}
    </Box>
  );
}

export interface HorizontalPickerOptions<T> {
  items: T[];
  /** Plain label for each item; the selected one is highlighted automatically. */
  label: (item: T) => string;
  /**
   * Optional badge rendered after the label in the accent color (e.g. a
   * "recommended" tag). Return null for items without one.
   */
  badge?: (item: T) => string | null;
  /** Optional header line shown above the row. */
  header?: string;
  /** Optional footer line shown below the row. */
  footer?: string;
  /** Initial highlighted index (defaults to 0). */
  initialIndex?: number;
  /** Separator between items (defaults to two spaces). */
  separator?: string;
  /**
   * Optional single-key shortcuts: a plain (non-modifier) keypress that resolves
   * the picker immediately with the mapped item, without moving the selection.
   * e.g. `{ f: fixAction }` lets `f` pick "Fix" directly.
   */
  hotkeys?: Record<string, T>;
}

interface PickHorizontalProps<T> {
  opts: HorizontalPickerOptions<T>;
  onResolve: (value: T | null) => void;
}

export function PickHorizontal<T>({ opts, onResolve }: PickHorizontalProps<T>): React.ReactElement {
  const items = opts.items;
  const initialIndex = Math.min(Math.max(0, opts.initialIndex ?? 0), Math.max(0, items.length - 1));
  const separator = opts.separator ?? "  ";
  const [selected, setSelected] = useState(initialIndex);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onResolve(null);
      return;
    }
    if (key.return) {
      onResolve(items[selected] ?? null);
      return;
    }
    // Single-key shortcuts resolve immediately. Guard on no modifiers so bound
    // keys (e.g. ctrl+f = next) still navigate rather than fire the shortcut.
    if (opts.hotkeys && !key.ctrl && !key.meta && input && input in opts.hotkeys) {
      const target = opts.hotkeys[input];
      if (target !== undefined) {
        onResolve(target);
        return;
      }
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

  const cells: React.ReactNode[] = [];
  items.forEach((item, i) => {
    const badge = opts.badge?.(item) ?? null;
    const label = ` ${opts.label(item)} `;
    if (i > 0) cells.push(<Text key={`sep-${i}`}>{separator}</Text>);
    cells.push(
      <Text key={i}>
        <Text inverse={i === selected} dimColor={i !== selected}>
          {label}
        </Text>
        {badge ? (
          <Text color={ACCENT_HEX} bold>
            {` ${badge} `}
          </Text>
        ) : null}
      </Text>,
    );
  });

  return (
    <Box width={'fit-content'} flexDirection="column" borderStyle={'round'} marginTop={1} marginBottom={1} padding={1}>
      {opts.header ? <Text>{opts.header}</Text> : null}
      <Text> </Text>
      <Box>{cells}</Box>
      <Text> </Text>
      {opts.footer ? <Text>{opts.footer}</Text> : null}
    </Box>
  );
}
