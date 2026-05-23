import { cyan, dim, useColor } from "./colors.js";

const reverseVideo = (text: string): string =>
  useColor ? `\x1b[7m${text}\x1b[27m` : `[${text}]`;

const ESC = "\x1b";
const CSI = `${ESC}[`;

const cursorUp = (n: number): string => (n > 0 ? `${CSI}${n}A` : "");
const cursorToCol = (col: number): string => `${CSI}${col}G`;
const clearBelow = `${CSI}0J`;

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
}

/**
 * Single-select TUI picker. Arrow keys to navigate, Enter to confirm, Esc or
 * Ctrl+C to cancel (resolves null). Erases its own output on exit so callers
 * can continue writing on a clean line.
 */
export function pickOne<T>(opts: PickerOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const items = opts.items;
    if (items.length === 0) {
      resolve(null);
      return;
    }

    const stdin = process.stdin;
    const stdout = process.stdout;
    const pageSize = Math.max(1, opts.pageSize ?? 10);

    let selected = Math.min(Math.max(0, opts.initialIndex ?? 0), items.length - 1);
    let windowStart = 0;
    let lastLines = 0;
    let hasRendered = false;
    let settled = false;

    const ensureVisible = (): void => {
      if (selected < windowStart) windowStart = selected;
      if (selected >= windowStart + pageSize) windowStart = selected - pageSize + 1;
      const maxStart = Math.max(0, items.length - pageSize);
      if (windowStart > maxStart) windowStart = maxStart;
    };

    const render = (): void => {
      ensureVisible();

      const lines: string[] = [];
      if (opts.header) lines.push(opts.header);
      const end = Math.min(items.length, windowStart + pageSize);
      for (let i = windowStart; i < end; i++) {
        lines.push(opts.render(items[i] as T, i === selected));
      }
      if (items.length > pageSize) {
        const indicator = `  (${selected + 1}/${items.length})`;
        lines.push(useColor ? dim(indicator) : indicator);
      }
      if (opts.footer) lines.push(opts.footer);

      if (hasRendered) {
        if (lastLines > 1) stdout.write(cursorUp(lastLines - 1));
        stdout.write(cursorToCol(1));
        stdout.write(clearBelow);
      }
      stdout.write(lines.join("\n"));
      lastLines = lines.length;
      hasRendered = true;
    };

    const erase = (): void => {
      if (!hasRendered) return;
      if (lastLines > 1) stdout.write(cursorUp(lastLines - 1));
      stdout.write(cursorToCol(1));
      stdout.write(clearBelow);
    };

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      try {
        if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      } catch {
        // stdin may already be destroyed; ignore.
      }
      try {
        stdin.pause();
      } catch {
        // ignore.
      }
    };

    const settle = (value: T | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onEnd = (): void => {
      erase();
      settle(null);
    };

    const onData = (data: Buffer): void => {
      const str = data.toString("utf8");

      if (str === "\x03") {
        // Ctrl+C
        erase();
        settle(null);
        return;
      }
      if (str === "\x1b") {
        // Esc
        erase();
        settle(null);
        return;
      }
      if (str === "\r" || str === "\n") {
        const pick = (items[selected] as T | undefined) ?? null;
        erase();
        settle(pick);
        return;
      }
      if (str === `${CSI}A` || str === "\x10") {
        // Up / Ctrl+P
        selected = (selected - 1 + items.length) % items.length;
        render();
        return;
      }
      if (str === `${CSI}B` || str === "\x0e") {
        // Down / Ctrl+N
        selected = (selected + 1) % items.length;
        render();
        return;
      }
      if (str === `${CSI}H` || str === "\x01") {
        // Home / Ctrl+A
        selected = 0;
        render();
        return;
      }
      if (str === `${CSI}F` || str === "\x05") {
        // End / Ctrl+E
        selected = items.length - 1;
        render();
        return;
      }
      // Ignore anything else (incl. other escape sequences, printable chars).
    };

    if (stdin.readableEnded || stdin.destroyed) {
      resolve(null);
      return;
    }
    try {
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    } catch {
      // non-TTY or already destroyed.
    }
    try {
      (stdin as { ref?: () => void }).ref?.();
    } catch {
      // not all stdin types support ref/unref.
    }
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
    stdin.resume();
    render();
  });
}

/** Convenience helper to colour the selection arrow consistently. */
export const pickerArrow = (selected: boolean): string =>
  selected ? cyan("❯") : " ";

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

/**
 * Single-select TUI picker laid out on one line. Left/Right (or h/l) to
 * navigate, Enter to confirm, Esc/Ctrl+C to cancel (resolves null). Erases
 * its own output on exit.
 */
export function pickHorizontal<T>(opts: HorizontalPickerOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const items = opts.items;
    if (items.length === 0) {
      resolve(null);
      return;
    }

    const stdin = process.stdin;
    const stdout = process.stdout;
    const separator = opts.separator ?? "  ";

    let selected = Math.min(Math.max(0, opts.initialIndex ?? 0), items.length - 1);
    let lastLines = 0;
    let hasRendered = false;
    let settled = false;

    const render = (): void => {
      const row = items
        .map((item, i) => {
          const label = opts.label(item);
          return i === selected ? reverseVideo(` ${label} `) : ` ${dim(label)} `;
        })
        .join(separator);

      const lines: string[] = [];
      if (opts.header) lines.push(opts.header);
      lines.push("");
      lines.push(row);
      lines.push("");
      if (opts.footer) lines.push(opts.footer);

      if (hasRendered) {
        if (lastLines > 1) stdout.write(cursorUp(lastLines - 1));
        stdout.write(cursorToCol(1));
        stdout.write(clearBelow);
      }
      stdout.write(lines.join("\n"));
      lastLines = lines.length;
      hasRendered = true;
    };

    const erase = (): void => {
      if (!hasRendered) return;
      if (lastLines > 1) stdout.write(cursorUp(lastLines - 1));
      stdout.write(cursorToCol(1));
      stdout.write(clearBelow);
    };

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      try {
        if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      } catch {
        // ignore
      }
      try {
        stdin.pause();
      } catch {
        // ignore
      }
    };

    const settle = (value: T | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onEnd = (): void => {
      erase();
      settle(null);
    };

    const onData = (data: Buffer): void => {
      const str = data.toString("utf8");

      if (str === "\x03" || str === "\x1b") {
        erase();
        settle(null);
        return;
      }
      if (str === "\r" || str === "\n") {
        const pick = (items[selected] as T | undefined) ?? null;
        erase();
        settle(pick);
        return;
      }
      if (str === `${CSI}D` || str === "\x02" || str === "h") {
        // Left / Ctrl+B / h
        selected = (selected - 1 + items.length) % items.length;
        render();
        return;
      }
      if (str === `${CSI}C` || str === "\x06" || str === "l") {
        // Right / Ctrl+F / l
        selected = (selected + 1) % items.length;
        render();
        return;
      }
      if (str === `${CSI}H` || str === "\x01") {
        // Home / Ctrl+A
        selected = 0;
        render();
        return;
      }
      if (str === `${CSI}F` || str === "\x05") {
        // End / Ctrl+E
        selected = items.length - 1;
        render();
        return;
      }
      // Ignore everything else.
    };

    if (stdin.readableEnded || stdin.destroyed) {
      resolve(null);
      return;
    }
    try {
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    } catch {
      // non-TTY or already destroyed
    }
    try {
      (stdin as { ref?: () => void }).ref?.();
    } catch {
      // ignore
    }
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
    stdin.resume();
    render();
  });
}
