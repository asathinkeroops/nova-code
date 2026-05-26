import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { highlight, supportsLanguage } from "cli-highlight";
import { dim, useColor } from "../colors.js";

const MAX_CONTENT_LINES = 300;
const COMPACT_MAX_LINES = 7;

const ADD_BG_OPEN = "\x1b[48;2;14;68;41m";
const ADD_BG_CLOSE = "\x1b[49m";
const GUTTER_FG_OPEN = "\x1b[38;2;127;217;154m";
const GUTTER_FG_CLOSE = "\x1b[39m";
const DEL_BG_OPEN = "\x1b[48;2;73;15;15m";
const DEL_BG_CLOSE = "\x1b[49m";
const DEL_FG_OPEN = "\x1b[38;2;255;128;128m";
const DEL_FG_CLOSE = "\x1b[39m";
const CLEAR_TO_EOL = "\x1b[K";

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  sql: "sql",
  xml: "xml",
  vue: "html",
  svelte: "html",
  dockerfile: "dockerfile",
};

function languageFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split(/[\\/]/).pop() ?? "";
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  const ext = base.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (!ext) return undefined;
  const lang = EXT_TO_LANG[ext];
  return lang && supportsLanguage(lang) ? lang : undefined;
}

function highlightContent(content: string, path: string | undefined): string {
  const language = languageFromPath(path);
  try {
    return highlight(
      content,
      language ? { language, ignoreIllegals: true } : { ignoreIllegals: true },
    );
  } catch {
    return content;
  }
}

export function splitDisplayLines(s: string): string[] {
  if (s.length === 0) return [];
  const lines = s.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function renderDiff(oldText: string, newText: string, path: string | undefined): string {
  const oldLines = splitDisplayLines(oldText);
  const newLines = splitDisplayLines(newText);

  const total = oldLines.length + newLines.length;
  const oldBudget =
    oldLines.length === 0
      ? 0
      : Math.min(
          oldLines.length,
          Math.max(1, Math.floor((MAX_CONTENT_LINES * oldLines.length) / Math.max(1, total))),
        );
  const newBudget = Math.min(newLines.length, Math.max(0, MAX_CONTENT_LINES - oldBudget));
  const oldShown = oldLines.slice(0, oldBudget);
  const newShown = newLines.slice(0, newBudget);

  const highlightedOld =
    oldShown.length === 0 ? [] : highlightContent(oldShown.join("\n"), path).split("\n");
  const highlightedNew =
    newShown.length === 0 ? [] : highlightContent(newShown.join("\n"), path).split("\n");

  const rendered: string[] = [];
  for (const line of highlightedOld) {
    if (!useColor) rendered.push(`- ${line}`);
    else
      rendered.push(
        `${DEL_BG_OPEN} ${DEL_FG_OPEN}-${DEL_FG_CLOSE} ${line}${CLEAR_TO_EOL}${DEL_BG_CLOSE}`,
      );
  }
  for (const line of highlightedNew) {
    if (!useColor) rendered.push(`+ ${line}`);
    else
      rendered.push(
        `${ADD_BG_OPEN} ${GUTTER_FG_OPEN}+${GUTTER_FG_CLOSE} ${line}${CLEAR_TO_EOL}${ADD_BG_CLOSE}`,
      );
  }

  const shown = oldShown.length + newShown.length;
  if (shown >= total) return rendered.join("\n");
  const hidden = total - shown;
  return `${rendered.join("\n")}\n${dim(`… (${hidden} more line${hidden === 1 ? "" : "s"} truncated)`)}`;
}

export function compactBody(body: string): string {
  const lines = body.split("\n");
  if (lines.length <= COMPACT_MAX_LINES) return body;
  const hidden = lines.length - COMPACT_MAX_LINES;
  const shown = lines.slice(0, COMPACT_MAX_LINES).join("\n");
  return `${shown}\n${dim(`… (${hidden} more line${hidden === 1 ? "" : "s"} hidden — collapsed after completion)`)}`;
}

export function readExisting(path: string): string | null {
  if (!path || path === "?") return null;
  try {
    const abs = resolve(process.cwd(), path);
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export function renderFileContent(content: string, path: string | undefined): string {
  const allLines = content.split("\n");
  const truncated = allLines.length > MAX_CONTENT_LINES;
  const shownLines = truncated ? allLines.slice(0, MAX_CONTENT_LINES) : allLines;
  const highlighted = highlightContent(shownLines.join("\n"), path).split("\n");

  const gutterWidth = String(shownLines.length).length;

  const rendered = highlighted.map((line, i) => {
    const lineNo = String(i + 1).padStart(gutterWidth, " ");
    if (!useColor) return `${lineNo} ${line}`;
    return `${dim(lineNo)} ${line}`;
  });

  if (!truncated) return rendered.join("\n");
  const hidden = allLines.length - MAX_CONTENT_LINES;
  return `${rendered.join("\n")}\n${dim(`… (${hidden} more line${hidden === 1 ? "" : "s"} truncated)`)}`;
}
