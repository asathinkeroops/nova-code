import { highlight, supportsLanguage } from "cli-highlight";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import {
  bold,
  cyan,
  dim,
  italic,
  magenta,
  strike,
  underline,
  yellow,
} from "../colors.js";

const HR_WIDTH = 60;
/**
 * Display width of an ANSI-bearing string in terminal cells. Delegates to
 * `string-width` — the SAME primitive `wrap-ansi` uses internally — so the
 * table renderer measures columns and the downstream hard-wrap (`measure.ts`)
 * agree on every character (CJK, emoji, and text-presentation symbols like
 * `↔`). A mismatch here is what chops a row's trailing border onto a phantom
 * line and garbles the box.
 */
function visibleLength(s: string): number {
  return stringWidth(s);
}

type Align = "left" | "center" | "right";

function parseTableRow(line: string): string[] | null {
  let t = line.trim();
  if (!t.includes("|")) return null;
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let j = 0; j < t.length; j++) {
    const ch = t[j];
    if (ch === "\\" && t[j + 1] === "|") {
      cur += "|";
      j++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch ?? "";
  }
  cells.push(cur.trim());
  return cells;
}

function parseTableSeparator(line: string): Align[] | null {
  const t = line.trim();
  if (!/^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t)) return null;
  const cells = parseTableRow(t);
  if (!cells) return null;
  return cells.map((c): Align => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function padCell(text: string, width: number, align: Align): string {
  const need = Math.max(0, width - visibleLength(text));
  if (align === "right") return " ".repeat(need) + text;
  if (align === "center") {
    const l = Math.floor(need / 2);
    return " ".repeat(l) + text + " ".repeat(need - l);
  }
  return text + " ".repeat(need);
}

/** Smallest column content width we'll shrink to before a table just clips. */
const MIN_TABLE_COL = 3;

/**
 * Fit natural per-column content widths into `avail` total cells using max-min
 * fair (water-filling) allocation: narrow columns keep their full width and the
 * surplus is split evenly among the wide ones, so only genuinely oversized
 * columns get squeezed. Returns the natural widths unchanged when they already
 * fit. Used to keep a table within the terminal so borders don't get chopped by
 * the downstream hard-wrap (which is what garbles a row that overflows).
 */
function fitColumnWidths(natural: number[], avail: number): number[] {
  const cols = natural.length;
  if (cols === 0) return [];
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= avail) return natural.slice();
  // Too tight even for minimums: hand out an even (>=1) share to every column.
  if (avail < cols * MIN_TABLE_COL) {
    const base = Math.max(1, Math.floor(avail / cols));
    return natural.map(() => base);
  }
  // Process columns narrowest-first: each takes its natural width if it fits
  // within the even share of the remaining budget, otherwise it's capped at
  // that share. Shares are non-decreasing, so every capped column gets >= the
  // first share, which is >= MIN_TABLE_COL by the guard above.
  const order = natural.map((w, idx) => ({ w, idx })).sort((a, b) => a.w - b.w);
  const result = new Array<number>(cols).fill(0);
  let remaining = avail;
  let left = cols;
  for (const { w, idx } of order) {
    const share = Math.floor(remaining / left);
    const give = w <= share ? w : share;
    result[idx] = give;
    remaining -= give;
    left--;
  }
  return result;
}

/**
 * Wrap one already-inline-rendered (ANSI-bearing) cell to `width` display
 * cells, returning its visual lines. `wrap-ansi` keeps color/bold codes intact
 * across breaks; `hard:true` guarantees even an unbroken token fits the column.
 */
function wrapCell(content: string, width: number): string[] {
  if (width <= 0 || visibleLength(content) <= width) return [content];
  return wrapAnsi(content, width, { hard: true, trim: true }).split("\n");
}

function highlightCode(code: string, lang: string | undefined): string {
  try {
    if (lang && supportsLanguage(lang)) {
      return highlight(code, { language: lang, ignoreIllegals: true });
    }
    return highlight(code, { ignoreIllegals: true });
  } catch {
    return code;
  }
}

/**
 * Source-faithful inline highlighting: unlike `renderInline`, this KEEPS the
 * literal markdown markers (`**`, backticks, `[]()`, …) and only colorizes
 * them, so the result still reads as raw source. Used for the file-content /
 * diff preview where we show source, not rendered output.
 */
function highlightInlineSource(text: string): string {
  const tokens: string[] = [];
  const stash = (s: string): string => {
    tokens.push(s);
    return `\x00${tokens.length - 1}\x00`;
  };

  let s = text;

  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(yellow(`\`${code}\``)));

  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, url: string) => stash(`${cyan(`[${label}]`)}${dim(`(${url})`)}`),
  );

  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => stash(bold(`**${t}**`)));
  s = s.replace(/__([^_\n]+)__/g, (_m, t: string) => stash(bold(`__${t}__`)));

  s = s.replace(
    /(^|[^*])\*([^*\n]+)\*(?!\*)/g,
    (_m, pre: string, t: string) => `${pre}${stash(italic(`*${t}*`))}`,
  );
  s = s.replace(
    /(^|[^_\w])_([^_\n]+)_(?!\w)/g,
    (_m, pre: string, t: string) => `${pre}${stash(italic(`_${t}_`))}`,
  );

  s = s.replace(/~~([^~\n]+)~~/g, (_m, t: string) => stash(strike(`~~${t}~~`)));

  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x00(\d+)\x00/g, (_m, i: string) => tokens[Number(i)] ?? "");
  return s;
}

/** Colorize one non-fenced markdown source line, preserving its raw text. */
function highlightMarkdownLine(line: string): string {
  const atx = /^(\s*)(#{1,6})(\s.*)$/.exec(line);
  if (atx) {
    const indent = atx[1] ?? "";
    const hashes = atx[2] ?? "";
    const rest = atx[3] ?? "";
    const level = hashes.length;
    const body = `${hashes}${rest}`;
    if (level === 1) return `${indent}${bold(magenta(body))}`;
    if (level === 2) return `${indent}${bold(cyan(body))}`;
    return `${indent}${bold(body)}`;
  }

  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return dim(line);

  const quote = /^(\s*>+\s?)(.*)$/.exec(line);
  if (quote) return `${dim(quote[1] ?? "")}${highlightInlineSource(quote[2] ?? "")}`;

  const ul = /^(\s*)([-*+])(\s+)(.*)$/.exec(line);
  if (ul) {
    return `${ul[1] ?? ""}${cyan(ul[2] ?? "")}${ul[3] ?? ""}${highlightInlineSource(ul[4] ?? "")}`;
  }

  const ol = /^(\s*)(\d+[.)])(\s+)(.*)$/.exec(line);
  if (ol) {
    return `${ol[1] ?? ""}${cyan(ol[2] ?? "")}${ol[3] ?? ""}${highlightInlineSource(ol[4] ?? "")}`;
  }

  return highlightInlineSource(line);
}

/**
 * Highlight markdown SOURCE (keeping all markers) for the file-content / diff
 * preview. `cli-highlight`'s markdown grammar emits no colors, so we do it
 * ourselves. Line count is preserved 1:1 so callers can split on "\n" and map
 * each line to a gutter / diff marker. Fenced code blocks are syntax-
 * highlighted via `cli-highlight` using the fence's language.
 */
export function highlightMarkdownSource(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLang: string | undefined;
  let fenceBuf: string[] = [];

  const flushFence = (): void => {
    if (fenceBuf.length === 0) return;
    out.push(...highlightCode(fenceBuf.join("\n"), fenceLang).split("\n"));
    fenceBuf = [];
  };

  for (const line of lines) {
    const fence = /^(\s*)```(\w+)?\s*$/.exec(line);
    if (fence) {
      if (inFence) {
        flushFence();
        inFence = false;
        fenceLang = undefined;
      } else {
        inFence = true;
        fenceLang = fence[2];
      }
      out.push(dim(line));
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }
    out.push(highlightMarkdownLine(line));
  }
  if (inFence) flushFence();
  return out.join("\n");
}

function renderInline(text: string): string {
  const tokens: string[] = [];
  const stash = (s: string): string => {
    tokens.push(s);
    return `\x00${tokens.length - 1}\x00`;
  };

  let s = text;

  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(yellow(code)));

  s = s.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_m, alt: string, url: string) => stash(`${dim("image:")} ${alt || dim(url)}`),
  );

  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, url: string) => stash(`${underline(cyan(label))} ${dim(`(${url})`)}`),
  );

  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => bold(t));
  s = s.replace(/__([^_\n]+)__/g, (_m, t: string) => bold(t));

  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, t: string) => `${pre}${italic(t)}`);
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, (_m, pre: string, t: string) => `${pre}${italic(t)}`);

  s = s.replace(/~~([^~\n]+)~~/g, (_m, t: string) => strike(t));

  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x00(\d+)\x00/g, (_m, i: string) => tokens[Number(i)] ?? "");
  return s;
}

function renderHeader(level: number, text: string): string {
  const inner = renderInline(text);
  if (level === 1) return bold(magenta(`# ${inner}`));
  if (level === 2) return bold(cyan(`## ${inner}`));
  if (level === 3) return bold(`### ${inner}`);
  return bold(dim(`${"#".repeat(level)} ${inner}`));
}

/**
 * Render markdown to an ANSI string. When `width` (the terminal inner width) is
 * given, tables are laid out to fit it — oversized columns are shrunk and their
 * cells wrapped onto multiple lines so the box borders stay aligned. Omitting
 * `width` keeps the renderer width-agnostic (natural, uncapped table widths).
 */
export function renderMarkdown(input: string, width?: number): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = /^(\s*)```(\w+)?\s*$/.exec(line);
    if (fence) {
      const indent = fence[1] ?? "";
      const lang = fence[2];
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++;
      const rendered = highlightCode(codeLines.join("\n"), lang);
      const block = rendered
        .split("\n")
        .map((l) => `${indent}${dim("│")} ${l}`)
        .join("\n");
      out.push(block);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length) {
      const headerCells = parseTableRow(line);
      const aligns = headerCells ? parseTableSeparator(lines[i + 1] ?? "") : null;
      if (headerCells && aligns && headerCells.length > 0) {
        const cols = Math.max(headerCells.length, aligns.length);
        const colAligns: Align[] = [];
        for (let c = 0; c < cols; c++) colAligns.push(aligns[c] ?? "left");

        const bodyRaw: string[][] = [];
        i += 2;
        while (i < lines.length) {
          const ln = lines[i] ?? "";
          if (!ln.includes("|") || ln.trim() === "") break;
          const r = parseTableRow(ln);
          if (!r) break;
          bodyRaw.push(r);
          i++;
        }

        const headers = headerCells.map(renderInline);
        const body = bodyRaw.map((r) => r.map(renderInline));
        while (headers.length < cols) headers.push("");
        for (const r of body) {
          while (r.length < cols) r.push("");
        }

        const natural: number[] = [];
        for (let c = 0; c < cols; c++) {
          let w = visibleLength(headers[c] ?? "");
          for (const r of body) w = Math.max(w, visibleLength(r[c] ?? ""));
          natural.push(w);
        }
        // Chrome per row = a leading/trailing bar plus, per column, one inner
        // bar's worth of separator and two padding spaces: `│ … │ … │`.
        const chrome = 3 * cols + 1;
        const avail = width !== undefined ? Math.max(cols, width - chrome) : undefined;
        const widths = avail !== undefined ? fitColumnWidths(natural, avail) : natural;

        const border = (left: string, mid: string, right: string): string => {
          const parts = widths.map((w) => "─".repeat(w + 2));
          return dim(left + parts.join(mid) + right);
        };
        const renderRow = (cells: string[], boldCells: boolean): string => {
          const bar = dim("│");
          const wrapped = cells.map((cell, c) =>
            wrapCell(boldCells ? bold(cell) : cell, widths[c] ?? 0),
          );
          const height = Math.max(1, ...wrapped.map((w) => w.length));
          const rows: string[] = [];
          for (let li = 0; li < height; li++) {
            const inner = widths
              .map((w, c) => ` ${padCell(wrapped[c]?.[li] ?? "", w, colAligns[c] ?? "left")} `)
              .join(bar);
            rows.push(`${bar}${inner}${bar}`);
          }
          return rows.join("\n");
        };

        out.push(border("┌", "┬", "┐"));
        out.push(renderRow(headers, true));
        out.push(border("├", "┼", "┤"));
        for (let bi = 0; bi < body.length; bi++) {
          out.push(renderRow(body[bi] ?? [], false));
          if (bi < body.length - 1) out.push(border("├", "┼", "┤"));
        }
        out.push(border("└", "┴", "┘"));
        continue;
      }
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(dim("─".repeat(HR_WIDTH)));
      i++;
      continue;
    }

    const next = lines[i + 1] ?? "";
    const setextH1 = i + 1 < lines.length && /^=+\s*$/.test(next) && line.trim().length > 0;
    const setextH2 = i + 1 < lines.length && /^-+\s*$/.test(next) && line.trim().length > 0;
    if (setextH1) {
      out.push(renderHeader(1, line.trim()));
      i += 2;
      continue;
    }
    if (setextH2) {
      out.push(renderHeader(2, line.trim()));
      i += 2;
      continue;
    }

    const atxHeader = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atxHeader) {
      const hashes = atxHeader[1] ?? "";
      const heading = atxHeader[2] ?? "";
      out.push(renderHeader(hashes.length, heading));
      i++;
      continue;
    }

    const quote = /^(\s*)>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`${quote[1] ?? ""}${dim("│")} ${dim(renderInline(quote[2] ?? ""))}`);
      i++;
      continue;
    }

    const ulItem = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    if (ulItem) {
      out.push(`${ulItem[1] ?? ""}${cyan("•")} ${renderInline(ulItem[3] ?? "")}`);
      i++;
      continue;
    }

    const olItem = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (olItem) {
      out.push(`${olItem[1] ?? ""}${cyan(`${olItem[2] ?? ""}.`)} ${renderInline(olItem[3] ?? "")}`);
      i++;
      continue;
    }

    if (line.trim() === "") {
      out.push("");
      i++;
      continue;
    }

    out.push(renderInline(line));
    i++;
  }

  return out.join("\n");
}
