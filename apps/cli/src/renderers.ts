import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { highlight, supportsLanguage } from "cli-highlight";
import { cyan, dim, green, italic, magenta, red, useColor } from "./colors.js";

const MAX_CONTENT_LINES = 300;

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
    return highlight(content, language ? { language, ignoreIllegals: true } : { ignoreIllegals: true });
  } catch {
    return content;
  }
}

function splitDisplayLines(s: string): string[] {
  if (s.length === 0) return [];
  const lines = s.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function renderDiff(oldText: string, newText: string, path: string | undefined): string {
  const oldLines = splitDisplayLines(oldText);
  const newLines = splitDisplayLines(newText);

  const total = oldLines.length + newLines.length;
  const oldBudget = oldLines.length === 0
    ? 0
    : Math.min(oldLines.length, Math.max(1, Math.floor((MAX_CONTENT_LINES * oldLines.length) / Math.max(1, total))));
  const newBudget = Math.min(newLines.length, Math.max(0, MAX_CONTENT_LINES - oldBudget));
  const oldShown = oldLines.slice(0, oldBudget);
  const newShown = newLines.slice(0, newBudget);

  const highlightedOld = oldShown.length === 0 ? [] : highlightContent(oldShown.join("\n"), path).split("\n");
  const highlightedNew = newShown.length === 0 ? [] : highlightContent(newShown.join("\n"), path).split("\n");

  const rendered: string[] = [];
  for (const line of highlightedOld) {
    if (!useColor) rendered.push(`- ${line}`);
    else rendered.push(`${DEL_BG_OPEN} ${DEL_FG_OPEN}-${DEL_FG_CLOSE} ${line}${CLEAR_TO_EOL}${DEL_BG_CLOSE}`);
  }
  for (const line of highlightedNew) {
    if (!useColor) rendered.push(`+ ${line}`);
    else rendered.push(`${ADD_BG_OPEN} ${GUTTER_FG_OPEN}+${GUTTER_FG_CLOSE} ${line}${CLEAR_TO_EOL}${ADD_BG_CLOSE}`);
  }

  const shown = oldShown.length + newShown.length;
  if (shown >= total) return rendered.join("\n");
  const hidden = total - shown;
  return `${rendered.join("\n")}\n${dim(`… (${hidden} more line${hidden === 1 ? "" : "s"} truncated)`)}`;
}

function readExisting(path: string): string | null {
  if (!path || path === "?") return null;
  try {
    const abs = resolve(process.cwd(), path);
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function renderFileContent(content: string, path: string | undefined): string {
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

export interface ToolUseEvent {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  is_error?: boolean;
  content: unknown;
}

export interface ToolRenderer {
  use?(input: Record<string, unknown>): string;
  result?(result: ToolResultEvent, input: Record<string, unknown> | undefined): string;
}

const trim = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const flatten = (s: string): string => s.replace(/\n/g, " ");

const contentToString = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("");
  }
  return JSON.stringify(content);
};

const errorLine = (result: ToolResultEvent): string =>
  red(`✗ ${flatten(trim(contentToString(result.content), 200))}`);

export const toolRenderers: Record<string, ToolRenderer> = {
  bash: {
    use: (input) => {
      const cmd = typeof input.command === "string" ? input.command : JSON.stringify(input);
      return `${cyan("▶")} ${cyan("bash")}  ${dim(trim(cmd, 200))}`;
    },
    result: (result) => {
      if (result.is_error) return errorLine(result);
      const text = contentToString(result.content);
      const lines = text.length === 0 ? 0 : text.split("\n").length;
      const preview = flatten(trim(text, 120));
      return `${green("✓")} ${dim(`${lines} line(s)`)}${preview ? `  ${dim(preview)}` : ""}`;
    },
  },

  read: {
    use: (input) => {
      const path = typeof input.path === "string" ? input.path : "?";
      const range =
        typeof input.offset === "number" || typeof input.limit === "number"
          ? ` ${dim(`[${input.offset ?? 0}..${input.limit ? (Number(input.offset ?? 0) + Number(input.limit)) : ""}]`)}`
          : "";
      return `${cyan("▶")} ${cyan("read")}  ${path}${range}`;
    },
    result: (result, _input) => {
      if (result.is_error) return errorLine(result);
      const text = contentToString(result.content);
      const lines = text.length === 0 ? 0 : text.split("\n").length;
      return `${green("✓")} ${dim(`${lines} line(s) · ${text.length} bytes`)}`;
    },
  },

  write: {
    use: (input) => {
      const path = typeof input.path === "string" ? input.path : "?";
      const content = typeof input.content === "string" ? input.content : "";
      const existing = readExisting(path);
      const lines = content.length === 0 ? 0 : content.split("\n").length;
      const verb = existing !== null ? "overwrite" : "write";
      const header = `${cyan("▶")} ${cyan(verb)}  ${path} ${dim(`(${content.length} bytes · ${lines} line${lines === 1 ? "" : "s"})`)}`;
      if (content.length === 0 && existing === null) return header;
      if (existing !== null) {
        return `${header}\n\n${renderDiff(existing, content, path)}`;
      }
      return `${header}\n\n${renderFileContent(content, path)}`;
    },
    result: (result, _input) => {
      if (result.is_error) return errorLine(result);
      const text = flatten(trim(contentToString(result.content), 200));
      return `${green("✓")} ${dim(text)}`;
    },
  },

  ask_user_question: {
    use: (input) => {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const headers = qs
        .map((q) => (q && typeof q === "object" && "header" in q ? String((q as { header: unknown }).header) : ""))
        .filter((h) => h.length > 0)
        .join(", ");
      return `${cyan("▶")} ${cyan("ask_user")}  ${dim(headers || `${qs.length} question(s)`)}`;
    },
    result: (result) => {
      if (result.is_error) return errorLine(result);
      const text = flatten(trim(contentToString(result.content), 200));
      return `${green("✓")} ${dim(text)}`;
    },
  },

  edit: {
    use: (input) => {
      const path = typeof input.path === "string" ? input.path : "?";
      const oldStr = typeof input.old_string === "string" ? input.old_string : "";
      const newStr = typeof input.new_string === "string" ? input.new_string : "";
      const replaceAll = input.replace_all === true;
      const oldLines = splitDisplayLines(oldStr).length;
      const newLines = splitDisplayLines(newStr).length;
      const meta = `-${oldLines} +${newLines}${replaceAll ? " · all" : ""}`;
      const header = `${cyan("▶")} ${cyan("edit")}  ${path} ${dim(`(${meta})`)}`;
      if (oldStr.length === 0 && newStr.length === 0) return header;
      return `${header}\n\n${renderDiff(oldStr, newStr, path)}`;
    },
    result: (result, _input) => {
      if (result.is_error) return errorLine(result);
      const text = flatten(trim(contentToString(result.content), 200));
      return `${green("✓")} ${dim(text)}`;
    },
  },

  grep: {
    result: (result, _input) => {
      if (result.is_error) return errorLine(result);
      const text = contentToString(result.content);
      if (text.startsWith("(no matches")) return `${green("✓")} ${dim("no matches")}`;
      if (text === "(no output)") return `${green("✓")} ${dim("no output")}`;

      const allLines = text.split("\n").filter((l) => l.length > 0);
      const truncated = allLines[allLines.length - 1]?.startsWith("…(truncated") ?? false;
      const lines = truncated ? allLines.slice(0, -1) : allLines;
      const trunc = truncated ? " (truncated)" : "";

      // match-line mode emits "path:lineNo:content"; files_with_matches mode emits bare paths.
      if (/^[^:]+:\d+:/.test(lines[0] ?? "")) {
        const matches = lines.filter((l) => /^[^:]+:\d+:/.test(l));
        const files = new Set(matches.map((l) => l.split(":", 1)[0]));
        return `${green("✓")} ${dim(`${matches.length} match(es) in ${files.size} file(s)${trunc}`)}`;
      }
      return `${green("✓")} ${dim(`${lines.length} file(s)${trunc}`)}`;
    },
  },

  glob: {
    result: (result, _input) => {
      if (result.is_error) return errorLine(result);
      const text = contentToString(result.content);
      if (text.startsWith("(no matches")) return `${green("✓")} ${dim("no matches")}`;
      // glob's own first line is a count header like "3 matches under /abs". Strip the path.
      const header = (text.split("\n", 1)[0] ?? "").replace(/\s+under\s+.+$/, "");
      return `${green("✓")} ${dim(header)}`;
    },
  },
};

export function renderThinking(text: string, label?: string): string {
  const header = `${magenta("✻")} ${dim(`thinking${label ? ` · ${label}` : ""}`)}`;
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.length === 0) return header;
  const body = trimmed
    .split("\n")
    .map((line) => dim(italic(line)))
    .join("\n");
  return `${header}\n${indentAsChild(body)}`;
}

export function renderRedactedThinking(label?: string): string {
  return `${magenta("✻")} ${dim(`thinking${label ? ` · ${label}` : ""} (redacted)`)}`;
}

export function renderToolUse(use: ToolUseEvent): string {
  const renderer = toolRenderers[use.name];
  if (renderer?.use) return renderer.use(use.input);
  const compact = JSON.stringify(use.input);
  return `${cyan("▶")} ${cyan(use.name)}  ${dim(trim(compact))}`;
}

function indentAsChild(s: string): string {
  if (s.length === 0) return s;
  const lines = s.split("\n");
  const head = `${dim("  ⎿  ")}${lines[0]}`;
  if (lines.length === 1) return head;
  return [head, ...lines.slice(1).map((line) => `     ${line}`)].join("\n");
}

export function renderToolResult(
  name: string | undefined,
  result: ToolResultEvent,
  input: Record<string, unknown> | undefined,
): string {
  const renderer = name ? toolRenderers[name] : undefined;
  let body: string;
  if (renderer?.result) {
    body = renderer.result(result, input);
  } else {
    const preview = flatten(trim(contentToString(result.content)));
    body = result.is_error ? red(`✗ ${preview}`) : `${green("✓")} ${dim(preview)}`;
  }
  return indentAsChild(body);
}
