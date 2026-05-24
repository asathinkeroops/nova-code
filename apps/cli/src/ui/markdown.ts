import { highlight, supportsLanguage } from "cli-highlight";
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
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function visibleLength(s: string): number {
  const stripped = s.replace(ANSI_RE, "");
  let w = 0;
  for (const ch of stripped) {
    w += charWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
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

export function renderMarkdown(input: string): string {
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

        const widths: number[] = [];
        for (let c = 0; c < cols; c++) {
          let w = visibleLength(headers[c] ?? "");
          for (const r of body) w = Math.max(w, visibleLength(r[c] ?? ""));
          widths.push(w);
        }

        const border = (left: string, mid: string, right: string): string => {
          const parts = widths.map((w) => "─".repeat(w + 2));
          return dim(left + parts.join(mid) + right);
        };
        const renderRow = (cells: string[], boldCells: boolean): string => {
          const bar = dim("│");
          const inner = cells
            .map((cell, c) => {
              const content = boldCells ? bold(cell) : cell;
              return ` ${padCell(content, widths[c] ?? 0, colAligns[c] ?? "left")} `;
            })
            .join(bar);
          return `${bar}${inner}${bar}`;
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
