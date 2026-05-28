import type { ToolResultBlock, ToolUseBlock } from "@nova/core";
import {
  blue,
  bold,
  cyan,
  dim,
  gray,
  green,
  italic,
  magenta,
  orange,
  red,
} from "../colors.js";
import type { BannerProps } from "./banner.js";
import { compactBody, readExisting, renderDiff, renderFileContent, splitDisplayLines } from "./diff.js";
import { renderMarkdown } from "./markdown.js";
import type { Card, CardKind } from "./store.js";
import type { RenderItem } from "./render-item.js";
import { visibleWidth } from "./width.js";


const cardColor: Record<CardKind, (s: string) => string> = {
  info: blue,
  warn: orange,
  error: red,
};

const trim = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const flatten = (s: string): string => s.replace(/\n/g, " ");

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "object" && b && "text" in b ? String((b as { text: unknown }).text) : "",
      )
      .join("");
  }
  return JSON.stringify(content);
}

function formatBytes(n: number): string {
  return n < 1024
    ? `${n} bytes`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ─── banner ────────────────────────────────────────────────────────────────

const LOGO = [
  "███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ ",
  "████╗  ██║██╔═══██╗██║   ██║██╔══██╗",
  "██╔██╗ ██║██║   ██║██║   ██║███████║",
  "██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║",
  "██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║",
  "╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝",
];

function displayCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

function renderBanner(b: BannerProps, width: number): string {
  const innerWidth = Math.max(40, Math.min(width, 80)) - 4;
  const top = `╭${"─".repeat(innerWidth + 2)}╮`;
  const bot = `╰${"─".repeat(innerWidth + 2)}╯`;
  const pad = (s: string): string => {
    const w = visibleWidth(s);
    const need = Math.max(0, innerWidth - w);
    return `│ ${s}${" ".repeat(need)} │`;
  };
  const lines: string[] = [];
  lines.push(top);
  lines.push(
    pad(`${cyan(">_")} Nova Coding Agent ${dim(`(v${b.version})`)}`),
  );
  lines.push(pad(""));
  for (const l of LOGO) lines.push(pad(cyan(l)));
  lines.push(pad(""));
  lines.push(pad(`${dim("model:")}     ${b.model}    ${dim("/model to change")}`));
  lines.push(pad(`${dim("workspace:")} ${displayCwd(b.cwd, b.home)}`));
  lines.push(pad(`${dim("session:")}   ${b.sessionId}`));
  lines.push(bot);
  return lines.join("\n");
}

// ─── user bubble ───────────────────────────────────────────────────────────

// Foreground-only, like the banner and cards — a painted background band
// can't pick a readable foreground without knowing the terminal theme. The
// whole user turn is magenta so it stands out clearly from assistant text,
// bracketed top and bottom by a dashed rule.
function renderUserBubble(text: string, width: number): string {
  const rule = dim("┄".repeat(Math.max(1, width)));
  const body = text
    .split("\n")
    .map((line, i) => magenta(`${i === 0 ? " › " : "   "}${line}`))
    .join("\n");
  return `${rule}\n${body}\n${rule}`;
}

// ─── thinking ──────────────────────────────────────────────────────────────

const THINKING_PREVIEW_CHARS = 200;

function renderThinking(text: string, label: string | undefined): string {
  const head = `${magenta("✻")} ${dim(`thinking${label ? ` · ${label}` : ""}`)}`;
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.length === 0) return head;
  const flat = trimmed.replace(/\s+/g, " ");
  const preview =
    flat.length > THINKING_PREVIEW_CHARS ? `${flat.slice(0, THINKING_PREVIEW_CHARS)}…` : flat;
  return `${head}\n${dim("  ⎿  ")}${dim(italic(preview))}`;
}

function renderRedactedThinking(label: string | undefined): string {
  return `${magenta("✻")} ${dim(`thinking${label ? ` · ${label}` : ""} (redacted)`)}`;
}

// ─── card ──────────────────────────────────────────────────────────────────

function renderCard(card: Card): string {
  const color = cardColor[card.kind];
  const bar = color("│");
  const bodyLines = card.text.split("\n");
  while (bodyLines.length > 0 && bodyLines[0]?.trim() === "") bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]?.trim() === "") {
    bodyLines.pop();
  }
  if (bodyLines.length === 0 && !card.title) return "";
  const out: string[] = [];
  if (card.title) out.push(`${bar} ${bold(color(card.title))}`);
  for (const line of bodyLines) out.push(`${bar} ${line}`);
  return out.join("\n");
}

// ─── tool calls ────────────────────────────────────────────────────────────

interface UseView {
  header: string;
  /** Multi-line body (diff / file content) printed below the header, blank line above. */
  body?: string;
}

interface ToolStr {
  use?(input: Record<string, unknown>): UseView;
  result?(result: ToolResultBlock, input: Record<string, unknown> | undefined): string;
  /** Collapse header+result onto one line (for summary-only tools). */
  inline?: boolean;
}

type ToolState = "pending" | "ok" | "err";

// Exact ANSI sequence for the pending dot. Exported so the viewport's blink
// timer can find and swap it for a blank "off" frame on the visible lines
// without re-rendering the whole transcript. Keep this the single source of
// truth for the glyph so the two stay byte-for-byte in sync.
export const PENDING_DOT = gray("●");

export function hasPendingDot(line: string): boolean {
  return line.includes(PENDING_DOT);
}

// Blink "off" frame: drop the dot (blank, same display width) so it visibly
// disappears. Operates on an already-rendered ANSI line.
export function blinkPendingOff(line: string): string {
  return line.split(PENDING_DOT).join(" ");
}

// Leading status dot, mirroring the result colors below (gray + blinking while
// pending, green ✓ on success, red ✗ on failure).
function marker(state: ToolState): string {
  if (state === "ok") return green("●");
  if (state === "err") return red("●");
  return PENDING_DOT;
}

function toolState(result: ToolResultBlock | undefined): ToolState {
  return result === undefined ? "pending" : result.is_error ? "err" : "ok";
}

function header(name: string, tail?: string): string {
  return `${cyan(name)}${tail ? `  ${tail}` : ""}`;
}

function okLine(text: string): string {
  if (!text) return `${green("✓")}`;
  return `${green("✓")} ${dim(text)}`;
}

function errLine(result: ToolResultBlock): string {
  return red(`✗ ${flatten(trim(contentToString(result.content), 200))}`);
}

const tools: Record<string, ToolStr> = {
  bash: {
    inline: true,
    use: (input) => {
      const cmd = typeof input.command === "string" ? input.command : JSON.stringify(input);
      // Flatten newlines first — heredoc / multi-line scripts would otherwise
      // turn the header into multiple unprefixed rows and break the slice's
      // height accounting (it expects one row per tool header).
      return { header: header("bash", dim(trim(flatten(cmd), 200))) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      const text = contentToString(result.content);
      if (text.length === 0) return okLine("(no output)");
      const firstLine = text.split("\n", 1)[0] ?? "";
      return okLine(trim(firstLine, 60));
    },
  },
  read: {
    inline: true,
    use: (input) => {
      const path = typeof input.path === "string" ? input.path : "?";
      const hasRange =
        typeof input.offset === "number" || typeof input.limit === "number";
      const rangeStr = hasRange
        ? `[${input.offset ?? 0}..${input.limit ? Number(input.offset ?? 0) + Number(input.limit) : ""}]`
        : "";
      return {
        header: header("read", `${path}${rangeStr ? ` ${dim(rangeStr)}` : ""}`),
      };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      const text = contentToString(result.content);
      const lines = text.length === 0 ? 0 : text.split("\n").length;
      return okLine(`${lines} line(s) · ${text.length} bytes`);
    },
  },
  write: {
    inline: true,
    use: (input) => {
      const path = typeof input.path === "string" ? input.path : "?";
      const content = typeof input.content === "string" ? input.content : "";
      const existing = readExisting(path);
      const lines = content.length === 0 ? 0 : content.split("\n").length;
      const verb = existing !== null ? "overwrite" : "write";
      const meta = `(${content.length} bytes · ${lines} line${lines === 1 ? "" : "s"})`;
      const h = header(verb, `${path} ${dim(meta)}`);
      if (content.length === 0 && existing === null) return { header: h };
      const body =
        existing !== null
          ? renderDiff(existing, content, path)
          : renderFileContent(content, path);
      return { header: h, body };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      return okLine(flatten(trim(contentToString(result.content), 200)));
    },
  },
  askUserQuestion: {
    use: (input) => {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const headers = qs
        .map((q) =>
          q && typeof q === "object" && "header" in q
            ? String((q as { header: unknown }).header)
            : "",
        )
        .filter((h) => h.length > 0)
        .join(", ");
      return { header: header("ask_user", dim(headers || `${qs.length} question(s)`)) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      return okLine(flatten(trim(contentToString(result.content), 200)));
    },
  },
  edit: {
    inline: true,
    use: (input) => {
      const path = typeof input.path === "string" ? input.path : "?";
      const oldStr = typeof input.old_string === "string" ? input.old_string : "";
      const newStr = typeof input.new_string === "string" ? input.new_string : "";
      const replaceAll = input.replace_all === true;
      const oldLines = splitDisplayLines(oldStr).length;
      const newLines = splitDisplayLines(newStr).length;
      const meta = `(-${oldLines} +${newLines}${replaceAll ? " · all" : ""})`;
      const h = header("edit", `${path} ${dim(meta)}`);
      if (oldStr.length === 0 && newStr.length === 0) return { header: h };
      return { header: h, body: renderDiff(oldStr, newStr, path) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      return okLine(flatten(trim(contentToString(result.content), 200)));
    },
  },
  grep: {
    inline: true,
    use: (input) => {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const path = typeof input.path === "string" ? input.path : "";
      const glob = typeof input.glob === "string" ? input.glob : "";
      const flags: string[] = [];
      if (input.case_insensitive === true) flags.push("-i");
      if (input.fixed_strings === true) flags.push("-F");
      if (input.files_with_matches === true) flags.push("-l");
      const parts: string[] = [`"${trim(pattern, 60)}"`];
      if (path) parts.push(`in ${path}`);
      if (glob) parts.push(`· ${glob}`);
      if (flags.length) parts.push(flags.join(" "));
      return { header: header("grep", dim(parts.join(" "))) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      const text = contentToString(result.content);
      if (text.startsWith("(no matches")) return okLine("no matches");
      if (text === "(no output)") return okLine("no output");
      const allLines = text.split("\n").filter((l) => l.length > 0);
      const truncated = allLines[allLines.length - 1]?.startsWith("…(truncated") ?? false;
      const lines = truncated ? allLines.slice(0, -1) : allLines;
      const trunc = truncated ? " (truncated)" : "";
      if (/^[^:]+:\d+:/.test(lines[0] ?? "")) {
        const matches = lines.filter((l) => /^[^:]+:\d+:/.test(l));
        const files = new Set(matches.map((l) => l.split(":", 1)[0]));
        return okLine(`${matches.length} match(es) in ${files.size} file(s)${trunc}`);
      }
      return okLine(`${lines.length} file(s)${trunc}`);
    },
  },
  glob: {
    inline: true,
    use: (input) => {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const path = typeof input.path === "string" ? input.path : "";
      const parts: string[] = [trim(pattern, 80)];
      if (path) parts.push(`in ${path}`);
      return { header: header("glob", dim(parts.join(" "))) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      const text = contentToString(result.content);
      if (text.startsWith("(no matches")) return okLine("no matches");
      const h = (text.split("\n", 1)[0] ?? "").replace(/\s+under\s+.+$/, "");
      return okLine(h);
    },
  },
  webfetch: {
    inline: true,
    use: (input) => {
      const url = typeof input.url === "string" ? input.url : "?";
      const format = typeof input.format === "string" ? input.format : "markdown";
      const fmtTail = format !== "markdown" ? ` ${dim(`→${format}`)}` : "";
      return { header: header("webfetch", `${trim(url, 120)}${fmtTail}`) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      const text = contentToString(result.content);
      const lines = text.length === 0 ? 0 : text.split("\n").length;
      return okLine(`${lines} line(s) · ${formatBytes(text.length)}`);
    },
  },
  websearch: {
    inline: true,
    use: (input) => {
      const query = typeof input.query === "string" ? input.query : "";
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const provider = typeof input.provider === "string" ? input.provider : "auto";
      const meta: string[] = [];
      if (limit !== undefined && limit !== 10) meta.push(`×${limit}`);
      if (provider !== "auto") meta.push(provider);
      const tail = meta.length > 0 ? ` ${dim(`(${meta.join(" ")})`)}` : "";
      return { header: header("websearch", `"${trim(query, 80)}"${tail}`) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      const text = contentToString(result.content);
      const head = text.split("\n", 1)[0] ?? "";
      const m = /^websearch\[(\w+)\]\s+(\d+|no)\s+results?/i.exec(head);
      if (!m) return okLine(flatten(trim(head, 80)));
      const [, provider, countTok] = m;
      const count = countTok === "no" ? 0 : Number.parseInt(countTok ?? "0", 10);
      return okLine(`${count} result(s) · ${provider}`);
    },
  },
  loadSkill: {
    inline: true,
    use: (input) => {
      const name = typeof input.name === "string" ? input.name : "?";
      return { header: header("skill", name) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      return okLine(formatBytes(contentToString(result.content).length));
    },
  },
  runLongRunningCommand: {
    inline: true,
    use: (input) => {
      const cmd = typeof input.command === "string" ? input.command : JSON.stringify(input);
      return { header: header("bg", dim(trim(flatten(cmd), 160))) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      const text = contentToString(result.content);
      try {
        const parsed = JSON.parse(text) as { id?: unknown };
        if (typeof parsed.id === "string") return okLine(`started ${parsed.id}`);
      } catch {
        // fall through
      }
      return okLine(flatten(trim(text, 80)));
    },
  },
};

function genericUseHeader(use: ToolUseBlock): string {
  const compact = JSON.stringify(use.input);
  return header(use.name, dim(trim(compact)));
}

function renderToolCall(use: ToolUseBlock, result: ToolResultBlock | undefined): string {
  const def = tools[use.name];
  const view: UseView = def?.use
    ? def.use(use.input as Record<string, unknown>)
    : { header: genericUseHeader(use) };
  const head = `${marker(toolState(result))} ${view.header}`;

  if (result === undefined) {
    // Inline tools (bash / read / write / edit / ...) keep the header on a
    // single row even while pending — skip the `⎿ …` placeholder row so the
    // approval-time layout matches the post-result layout, and tuck the body
    // right under the header (no blank row).
    if (def?.inline) {
      const body = view.body ? `\n${view.body}` : "";
      return `${head}${body}`;
    }
    const body = view.body ? `\n\n${view.body}` : "";
    return `${head}\n  ${dim("⎿")}  ${dim("…")}${body}`;
  }

  const resultStr = def?.result
    ? def.result(result, use.input as Record<string, unknown> | undefined)
    : result.is_error
      ? errLine(result)
      : okLine(flatten(trim(contentToString(result.content), 200)));

  if (def?.inline) {
    const body = view.body ? `\n${compactBody(view.body)}` : "";
    return `${head}  ${resultStr}${body}`;
  }

  const body = view.body ? `\n\n${compactBody(view.body)}` : "";
  return `${head}\n  ${dim("⎿")}  ${resultStr}${body}`;
}

// ─── read batch ────────────────────────────────────────────────────────────

const BATCH_MAX_VISIBLE = 5;

function renderReadBatch(
  entries: Array<{ use: ToolUseBlock; result: ToolResultBlock | undefined }>,
): string {
  const visible = entries.slice(0, BATCH_MAX_VISIBLE);
  const hidden = entries.length - visible.length;
  const batchState: ToolState = entries.some((e) => e.result === undefined)
    ? "pending"
    : entries.some((e) => e.result?.is_error === true)
      ? "err"
      : "ok";
  const head = `${marker(batchState)} ${header("read", `${entries.length} file${entries.length === 1 ? "" : "s"}`)}`;
  const rows = visible.map((entry, i) => {
    const input = entry.use.input as Record<string, unknown>;
    const path = typeof input.path === "string" ? input.path : "?";
    const r = entry.result;
    const mark = r === undefined ? dim("…") : r.is_error ? red("✗") : green("✓");
    const prefix = i === 0 ? `  ${dim("⎿")}  ` : "     ";
    return `${prefix}${mark} ${path}`;
  });
  if (hidden > 0) rows.push(`     ${dim(`… +${hidden} more`)}`);
  return [head, ...rows].join("\n");
}

// ─── dispatch ──────────────────────────────────────────────────────────────

/**
 * Render a single RenderItem to a multi-line ANSI string. The caller is
 * responsible for ANSI-aware wrapping at the target terminal width (we keep
 * the renderers width-agnostic except where layout cares — the banner box).
 */
export function renderItemToString(item: RenderItem, width: number): string {
  switch (item.kind) {
    case "banner":
      return renderBanner(item.banner, width);
    case "banner-hint":
      return dim(item.text);
    case "spacer":
      return "";
    case "user-text":
      return renderUserBubble(item.text, width);
    case "assistant-text":
      return renderMarkdown(item.text);
    case "thinking":
      return renderThinking(item.thinking, item.label);
    case "redacted-thinking":
      return renderRedactedThinking(item.label);
    case "tool-call":
      return renderToolCall(item.use, item.result);
    case "read-batch":
      return renderReadBatch(item.entries);
    case "card":
      return renderCard(item.card);
  }
}
