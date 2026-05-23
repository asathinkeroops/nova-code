import { cyan, dim, useColor } from "./colors.js";

const ESC = "\x1b";
const CSI = `${ESC}[`;

const cursorUp = (n: number): string => (n > 0 ? `${CSI}${n}A` : "");
const cursorDown = (n: number): string => (n > 0 ? `${CSI}${n}B` : "");
const cursorToCol = (col: number): string => `${CSI}${col}G`;
const clearBelow = `${CSI}0J`;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

function charDisplayWidth(s: string, i: number): number {
  const code = s.charCodeAt(i);
  if (code < 0x20 || code === 0x7f) return 0;
  return isWide(code) ? 2 : 1;
}

function visibleWidth(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) w += charDisplayWidth(s, i);
  return w;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export interface BoxedInputOptions {
  prompt?: string;
  placeholder?: string;
  /** Override terminal width detection (for tests). */
  width?: number;
  /** Slash commands shown in a popup when the buffer starts with "/". */
  commands?: SlashCommand[];
  /**
   * Called on every render to produce the lines drawn above the top rule.
   * Empty array / omitted = no header. Each entry occupies exactly one
   * terminal row — lines wider than the terminal are truncated with "…" to
   * keep cursor accounting correct. The getter form lets callers reflect
   * state that mutates outside this box's keystroke loop.
   */
  header?: () => string[];
}

interface DisplayLine {
  content: string;
  bufStart: number;
  bufEnd: number;
}

const POPUP_MAX_ROWS = 8;

const RULE_CHAR = "─";
const MIN_WIDTH = 20;

export function readBoxedLine(opts: BoxedInputOptions = {}): Promise<string | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const promptRaw = opts.prompt ?? cyan("› ");
  const promptLen = stripAnsi(promptRaw).length;
  const placeholderText = opts.placeholder ?? "";
  const commands = opts.commands ?? [];

  return new Promise((resolve) => {
    let buffer = "";
    let cursor = 0;
    let hasRendered = false;
    let lastCursorRow = 0;
    let lastContentLines = 1;
    let lastPopupLines = 0;
    let selectedSuggestion = 0;
    let popupDismissed = false;

    const getWidth = (): number =>
      Math.max(MIN_WIDTH, opts.width ?? stdout.columns ?? 80);

    const matchingCommands = (): SlashCommand[] => {
      if (popupDismissed || commands.length === 0) return [];
      if (!buffer.startsWith("/")) return [];
      const query = buffer.slice(1).toLowerCase();
      const seen = new Set<string>();
      const out: SlashCommand[] = [];
      for (const c of commands) {
        if (seen.has(c.name)) continue;
        const tail = c.name.startsWith("/") ? c.name.slice(1) : c.name;
        if (tail.toLowerCase().startsWith(query)) {
          seen.add(c.name);
          out.push(c);
        }
      }
      return out;
    };

    const buildPopupLines = (matches: SlashCommand[]): string[] => {
      if (matches.length === 0) return [];
      const visible = matches.slice(0, POPUP_MAX_ROWS);
      const nameWidth = Math.min(
        20,
        Math.max(...visible.map((m) => visibleWidth(m.name))),
      );
      const w = getWidth();
      const lines: string[] = [];
      for (let i = 0; i < visible.length; i++) {
        const m = visible[i];
        if (!m) continue;
        const isSel = i === selectedSuggestion;
        const namePad = " ".repeat(Math.max(1, nameWidth + 2 - visibleWidth(m.name)));
        const arrow = isSel ? "❯ " : "  ";
        const raw = `${arrow}${m.name}${namePad}${m.description}`;
        // Truncate to terminal width to avoid wrapping the popup.
        let truncated = raw;
        if (visibleWidth(raw) > w) {
          let acc = 0;
          let cut = 0;
          for (let j = 0; j < raw.length; j++) {
            const ww = charDisplayWidth(raw, j);
            if (acc + ww > w - 1) break;
            acc += ww;
            cut = j + 1;
          }
          truncated = raw.slice(0, cut) + "…";
        }
        if (isSel) {
          lines.push(useColor ? cyan(truncated) : truncated);
        } else {
          lines.push(useColor ? dim(truncated) : truncated);
        }
      }
      if (matches.length > visible.length) {
        const more = ` … ${matches.length - visible.length} more`;
        lines.push(useColor ? dim(more) : more);
      }
      return lines;
    };

    const layout = (): { lines: DisplayLine[]; cursorRow: number; cursorCol: number } => {
      const w = getWidth();
      const firstCap = Math.max(1, w - 1 - promptLen);
      const restCap = Math.max(1, w - 1);

      if (buffer.length === 0) {
        const ph = placeholderText && useColor ? dim(placeholderText) : placeholderText;
        return {
          lines: [{ content: " " + promptRaw + ph, bufStart: 0, bufEnd: 0 }],
          cursorRow: 0,
          cursorCol: 1 + promptLen,
        };
      }

      const lines: DisplayLine[] = [];
      let i = 0;
      while (i < buffer.length) {
        const cap = lines.length === 0 ? firstCap : restCap;
        const prefix = lines.length === 0 ? " " + promptRaw : " ";
        let j = i;
        let used = 0;
        while (j < buffer.length) {
          const ww = charDisplayWidth(buffer, j);
          if (used + ww > cap) break;
          used += ww;
          j++;
        }
        if (j === i) j = i + 1; // guarantee forward progress
        const slice = buffer.slice(i, j);
        lines.push({ content: prefix + slice, bufStart: i, bufEnd: j });
        i = j;
      }

      let cursorRow = 0;
      let cursorCol = 0;
      for (let li = 0; li < lines.length; li++) {
        const dl = lines[li];
        if (!dl) continue;
        const inLine =
          li === lines.length - 1 ? cursor <= dl.bufEnd : cursor < dl.bufEnd;
        if (cursor >= dl.bufStart && inLine) {
          cursorRow = li;
          const prefixCols = li === 0 ? 1 + promptLen : 1;
          cursorCol = prefixCols + visibleWidth(buffer.slice(dl.bufStart, cursor));
          break;
        }
      }

      return { lines, cursorRow, cursorCol };
    };

    const truncateToWidth = (line: string, w: number): string => {
      if (visibleWidth(line) <= w) return line;
      let acc = 0;
      let cut = 0;
      for (let j = 0; j < line.length; j++) {
        const ww = charDisplayWidth(line, j);
        if (acc + ww > w - 1) break;
        acc += ww;
        cut = j + 1;
      }
      return line.slice(0, cut) + "…";
    };

    const render = (): void => {
      const w = getWidth();
      const rule = RULE_CHAR.repeat(w);
      const ruleStr = useColor ? dim(rule) : rule;
      const { lines, cursorRow, cursorCol } = layout();
      const matches = matchingCommands();
      if (selectedSuggestion >= matches.length) selectedSuggestion = 0;
      const popupLines = buildPopupLines(matches);
      const headerLines = (opts.header?.() ?? []).map((line) => truncateToWidth(line, w));

      if (hasRendered) {
        stdout.write(cursorUp(lastCursorRow));
        stdout.write(cursorToCol(1));
        stdout.write(clearBelow);
      }

      for (const hl of headerLines) {
        stdout.write(hl + "\n");
      }
      stdout.write(ruleStr);
      for (const dl of lines) {
        stdout.write("\n" + dl.content);
      }
      stdout.write("\n" + ruleStr);
      for (const pl of popupLines) {
        stdout.write("\n" + pl);
      }

      // Cursor is at the end of the last rendered line (bottom rule or last popup line).
      // Box layout (row indices from top, 0-based):
      //   row 0..H-1      header lines (H = headerLines.length)
      //   row H           top rule
      //   row H+1..H+N    content lines (N = lines.length)
      //   row H+1+N       bottom rule
      //   row H+2+N..H+1+N+P  popup lines (P = popupLines.length)
      // Target content row = H + 1 + cursorRow.
      // We're at row H+1+N+P, need to move up (N + P - cursorRow) rows.
      stdout.write(cursorUp(lines.length + popupLines.length - cursorRow));
      stdout.write(cursorToCol(cursorCol + 1));

      lastCursorRow = headerLines.length + 1 + cursorRow;
      lastContentLines = lines.length;
      lastPopupLines = popupLines.length;
      hasRendered = true;
    };

    const exitBox = (): void => {
      // Erase the entire input box (top rule, content, bottom rule, and any
      // popup) so subsequent output starts on a clean line in its place.
      if (!hasRendered) return;
      stdout.write(cursorUp(lastCursorRow));
      stdout.write(cursorToCol(1));
      stdout.write(clearBelow);
    };

    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
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

    const onEnd = (): void => {
      // stdin closed (e.g. piped input drained, or a subprocess inherited and
      // closed it). Exit cleanly so the REPL prints "bye." instead of silently
      // dropping out of the event loop mid-render.
      exitBox();
      settle(null);
    };

    const onData = (data: Buffer): void => {
      const str = data.toString("utf8");

      // Ctrl+C
      if (str === "\x03") {
        exitBox();
        settle(null);
        return;
      }
      // Ctrl+D: ignore — only Ctrl+C exits, /exit submits, so we don't
      // want a stray EOF byte (e.g. left over from another component touching
      // stdin during a turn) to silently kill the REPL.
      if (str === "\x04") return;
      // Enter
      if (str === "\r" || str === "\n") {
        if (buffer.length === 0) return;
        // If the slash-command popup is visible, submit the highlighted command
        // instead of whatever partial text the user has typed so far.
        const matches = matchingCommands();
        const pick = matches[selectedSuggestion];
        const out = pick ? pick.name : buffer;
        exitBox();
        stdout.write(`${promptRaw}${out}\n`);
        settle(out);
        return;
      }
      // Backspace
      if (str === "\x7f" || str === "\b") {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          popupDismissed = false;
          selectedSuggestion = 0;
          render();
        }
        return;
      }
      // Up / Down: navigate the slash-command popup when it's visible.
      if (str === `${CSI}A`) {
        const count = matchingCommands().length;
        if (count > 0) {
          selectedSuggestion = (selectedSuggestion - 1 + count) % count;
          render();
        }
        return;
      }
      if (str === `${CSI}B`) {
        const count = matchingCommands().length;
        if (count > 0) {
          selectedSuggestion = (selectedSuggestion + 1) % count;
          render();
        }
        return;
      }
      // Tab: complete the selected slash-command suggestion into the buffer.
      if (str === "\t") {
        const matches = matchingCommands();
        const pick = matches[selectedSuggestion];
        if (pick) {
          buffer = pick.name;
          cursor = buffer.length;
          popupDismissed = true;
          render();
        }
        return;
      }
      // Esc: dismiss the popup without changing the buffer.
      if (str === "\x1b") {
        if (!popupDismissed && matchingCommands().length > 0) {
          popupDismissed = true;
          selectedSuggestion = 0;
          render();
        }
        return;
      }
      // Arrow / nav keys
      if (str === `${CSI}D`) {
        if (cursor > 0) {
          cursor--;
          render();
        }
        return;
      }
      if (str === `${CSI}C`) {
        if (buffer.length === 0 && placeholderText.length > 0) {
          buffer = placeholderText;
          cursor = buffer.length;
          popupDismissed = false;
          selectedSuggestion = 0;
          render();
          return;
        }
        if (cursor < buffer.length) {
          cursor++;
          render();
        }
        return;
      }
      if (str === `${CSI}H` || str === "\x01") {
        if (cursor !== 0) {
          cursor = 0;
          render();
        }
        return;
      }
      if (str === `${CSI}F` || str === "\x05") {
        if (cursor !== buffer.length) {
          cursor = buffer.length;
          render();
        }
        return;
      }
      // Ctrl+U: kill to start
      if (str === "\x15") {
        if (cursor > 0) {
          buffer = buffer.slice(cursor);
          cursor = 0;
          popupDismissed = false;
          selectedSuggestion = 0;
          render();
        }
        return;
      }
      // Ctrl+K: kill to end
      if (str === "\x0b") {
        if (cursor < buffer.length) {
          buffer = buffer.slice(0, cursor);
          popupDismissed = false;
          selectedSuggestion = 0;
          render();
        }
        return;
      }
      // Ctrl+W: delete previous word
      if (str === "\x17") {
        if (cursor > 0) {
          const left = buffer.slice(0, cursor);
          const trimmed = left.replace(/\S*\s*$/, "");
          buffer = trimmed + buffer.slice(cursor);
          cursor = trimmed.length;
          popupDismissed = false;
          selectedSuggestion = 0;
          render();
        }
        return;
      }
      // Delete forward (Esc[3~)
      if (str === `${CSI}3~`) {
        if (cursor < buffer.length) {
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
          popupDismissed = false;
          selectedSuggestion = 0;
          render();
        }
        return;
      }
      // Ignore other escape sequences.
      if (str.startsWith(ESC)) return;

      // Strip control chars from incoming text (e.g. pasted \t becomes ignored).
      const text = str.replace(/[\x00-\x1f]/g, "");
      if (text.length === 0) return;

      buffer = buffer.slice(0, cursor) + text + buffer.slice(cursor);
      cursor += text.length;
      popupDismissed = false;
      selectedSuggestion = 0;
      render();
    };

    // If stdin already ended (e.g. piped-in input drained, or something
    // closed it during an earlier turn), bail out before rendering anything.
    if (stdin.readableEnded || stdin.destroyed) {
      resolve(null);
      return;
    }

    try {
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    } catch {
      // non-TTY or already destroyed; fall back to whatever mode it's in.
    }
    // Ink unrefs stdin on unmount, which can leave the event loop with
    // nothing keeping it alive — the process then exits silently the next
    // time we await stdin. Re-ref before resuming so this loop survives a
    // prior Ink render (e.g. the permission prompt).
    try {
      (stdin as { ref?: () => void }).ref?.();
    } catch {
      // ignore — not all stdin types support ref/unref.
    }
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
    stdin.resume();
    render();
  });
}
