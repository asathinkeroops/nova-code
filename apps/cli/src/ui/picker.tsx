import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { accent, dim, useColor } from "../colors.js";
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

export interface HorizontalPickerOptions<T> {
  items: T[];
  /** Plain label for each item; the selected one is highlighted automatically. */
  label: (item: T) => string;
  /** Optional header line shown above the row. */
  header?: string;
  /** Optional footer line shown below the row. */
  footer?: string;
  /** Initial highlighted index (defaults to 0). */
  initialIndex?: number;
  /** Separator between items (defaults to two spaces). */
  separator?: string;
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
    const text = ` ${opts.label(item)} `;
    if (i > 0) cells.push(<Text key={`sep-${i}`}>{separator}</Text>);
    if (i === selected) {
      cells.push(
        <Text key={i} inverse>
          {text}
        </Text>,
      );
    } else {
      cells.push(
        <Text key={i} dimColor>
          {text}
        </Text>,
      );
    }
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
