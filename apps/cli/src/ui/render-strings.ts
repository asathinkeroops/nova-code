import type { ToolResultBlock, ToolUseBlock } from "@nova/core";
import type { SubAgentDetail } from "@nova/subagent";
import wrapAnsi from "wrap-ansi";
import {
  accent,
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
  rgbFg,
  useTruecolor,
  type Rgb,
} from "../colors.js";
import { compactBody, readExisting, renderDiff, renderFileContent, splitDisplayLines } from "./diff.js";
import { renderMarkdown } from "./markdown.js";
import type { Card, CardKind } from "./store.js";
import type { BannerProps, RenderItem } from "./render-item.js";


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
  "██   ██  ████  ██   ██  █████         █████  ████  █████  ██████",
  "███  ██ ██  ██ ██   ██ ██   ██       ██     ██  ██ ██  ██ ██    ",
  "██ █ ██ ██  ██ ██   ██ ███████ █████ ██     ██  ██ ██  ██ █████ ",
  "██  ███ ██  ██  ██ ██  ██   ██       ██     ██  ██ ██  ██ ██    ",
  "██   ██  ████    ███   ██   ██        █████  ████  █████  ██████",
];

// Cyberpunk vertical gradient (cyan → magenta), one stop per LOGO row.
const LOGO_GRADIENT: Rgb[] = [
  [0, 238, 255],
  [90, 160, 255],
  [170, 110, 245],
  [230, 80, 210],
  [255, 60, 170],
];

// 16-color fallback for terminals without truecolor, tracing the same arc.
const LOGO_FALLBACK = [accent, blue, magenta, magenta, magenta];

/** Color one LOGO row by its vertical position, degrading like `orange`. */
function bannerLine(line: string, row: number): string {
  if (useTruecolor) {
    const stop = LOGO_GRADIENT[row];
    return stop ? rgbFg(stop, line) : accent(line);
  }
  return (LOGO_FALLBACK[row] ?? accent)(line);
}

function displayCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

function formatModel(b: BannerProps): string {
  const base = b.contextWindowTokens
    ? (() => {
        const window = b.contextWindowTokens >= 1_000_000
          ? `${Math.round(b.contextWindowTokens / 1_000_000)}m`
          : b.contextWindowTokens >= 1_000
          ? `${Math.round(b.contextWindowTokens / 1_000)}k`
          : `${b.contextWindowTokens}`;
        return `${b.model}[${window}]`;
      })()
    : b.model;
  return b.thinkingLabel ? `${base} with ${accent(bold(b.thinkingLabel))} effort` : base;
}

function renderBanner(b: BannerProps, width: number): string {
  void width;
  const lines: string[] = [];
  lines.push(`${accent(">_")} Nova Code ${dim(`(v${b.version})`)}`);
  lines.push("");
  LOGO.forEach((l, i) => lines.push(bannerLine(l, i)));
  lines.push("");
  lines.push(
    dim("The coding agent tuned to the metal for DeepSeek — 90%+ cache hits."),
  );
  lines.push("");
  lines.push(`${dim("model:")}     ${formatModel(b)}`);
  lines.push(`${dim("workspace:")} ${displayCwd(b.cwd, b.home)}`);
  lines.push(`${dim("session:")}   ${b.sessionId}`);
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

const THINKING_INDENT = "     "; // aligns continuation rows under the `⎿` body

// When a thinking block is collapsed (its reasoning is done), show at most this
// many wrapped body rows before summarizing the rest with a `… +N lines` hint.
const THINKING_COLLAPSED_MAX_LINES = 3;

function renderThinking(
  text: string,
  label: string | undefined,
  width: number,
  collapsed = false,
): string {
  const head = `${magenta("✻")} ${dim(`thinking${label ? ` · ${label}` : ""}`)}`;
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.length === 0) return head;
  // Wrap the reasoning ourselves at the body width and prefix a hanging indent
  // so soft-wrapped long lines stay aligned under the `⎿` marker instead of
  // falling back to column 0.
  const bodyWidth = Math.max(1, width - THINKING_INDENT.length);
  const lines = wrapAnsi(trimmed, bodyWidth, { hard: true, wordWrap: false, trim: false }).split(
    "\n",
  );
  // Once thinking is done we collapse it to a short preview: the first few
  // wrapped rows plus a one-line hint counting what was hidden. While streaming
  // (collapsed === false) the full reasoning is shown.
  const hidden = collapsed ? Math.max(0, lines.length - THINKING_COLLAPSED_MAX_LINES) : 0;
  const shown = hidden > 0 ? lines.slice(0, THINKING_COLLAPSED_MAX_LINES) : lines;
  const body = shown
    .map((line, i) => `${dim(i === 0 ? "  ⎿  " : THINKING_INDENT)}${dim(italic(line))}`)
    .join("\n");
  if (hidden > 0) {
    return `${head}\n${body}\n${dim(`${THINKING_INDENT}… +${hidden} lines`)}`;
  }
  return `${head}\n${body}`;
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

// Tool-use header: the tool name keeps real cyan (like markdown body), not the
// UI accent — tool calls in the feed read as content, not chrome.
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
      const off = typeof input.offset === "number" ? input.offset : undefined;
      const lim = typeof input.limit === "number" ? input.limit : undefined;
      const rangeStr =
        off !== undefined || lim !== undefined
          ? `[${off ?? 0}..${lim !== undefined ? (off ?? 0) + lim : ""}]`
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
    inline: true,
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
      return { header: header("ask", dim(headers || `${qs.length} question(s)`)) };
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
  createSubAgent: {
    inline: true,
    use: (input) => {
      const description =
        typeof input.description === "string" ? input.description : "sub-agent";
      const type = typeof input.type === "string" ? input.type : "";
      const label = type ? `${type} · ${description}` : description;
      return { header: header("agent", trim(label, 120)) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      const text = contentToString(result.content);
      const lines = text.length === 0 ? 0 : text.split("\n").length;
      return okLine(`${lines} line(s) · ${formatBytes(text.length)}`);
    },
  },
};

function genericUseHeader(use: ToolUseBlock): string {
  const compact = JSON.stringify(use.input);
  return header(use.name, dim(trim(compact)));
}

/** Glyph per sub-agent detail kind, shown at the head of each detail row. */
const DETAIL_MARK: Record<SubAgentDetail["type"], string> = {
  thinking: "✻",
  tool_use: "⚒",
  final: "→",
};

/**
 * Render the latest sub-agent progress details as dim, indented rows aligned
 * under the tool-call's `⎿` result gutter. Returns "" when there are none.
 */
function renderSubAgentDetails(details: SubAgentDetail[] | undefined): string {
  if (!details || details.length === 0) return "";
  const rows = details.map((d) => {
    const text = d.type === "tool_use" ? `${d.name}: ${d.summary}` : d.text;
    return `     ${dim(`${DETAIL_MARK[d.type]} ${flatten(trim(text, 160))}`)}`;
  });
  return `\n${rows.join("\n")}`;
}

function renderToolCall(
  use: ToolUseBlock,
  result: ToolResultBlock | undefined,
  details?: SubAgentDetail[],
): string {
  const def = tools[use.name];
  const view: UseView = def?.use
    ? def.use(use.input as Record<string, unknown>)
    : { header: genericUseHeader(use) };
  const head = `${marker(toolState(result))} ${view.header}`;
  const detailRows = renderSubAgentDetails(details);

  if (result === undefined) {
    // Inline tools (bash / read / write / edit / ...) keep the header on a
    // single row even while pending — skip the `⎿ …` placeholder row so the
    // approval-time layout matches the post-result layout, and tuck the body
    // right under the header (no blank row).
    if (def?.inline) {
      const body = view.body ? `\n${view.body}` : "";
      return `${head}${body}${detailRows}`;
    }
    const body = view.body ? `\n\n${view.body}` : "";
    return `${head}\n  ${dim("⎿")}  ${dim("…")}${body}${detailRows}`;
  }

  const resultStr = def?.result
    ? def.result(result, use.input as Record<string, unknown> | undefined)
    : result.is_error
      ? errLine(result)
      : okLine(flatten(trim(contentToString(result.content), 200)));

  if (def?.inline) {
    const body = view.body ? `\n${compactBody(view.body)}` : "";
    return `${head}  ${resultStr}${body}${detailRows}`;
  }

  const body = view.body ? `\n\n${compactBody(view.body)}` : "";
  return `${head}\n  ${dim("⎿")}  ${resultStr}${body}${detailRows}`;
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
    case "spacer":
      return "";
    case "user-text":
      return renderUserBubble(item.text, width);
    case "assistant-text":
      return renderMarkdown(item.text);
    case "thinking":
      return renderThinking(item.thinking, item.label, width, item.collapsed ?? false);
    case "redacted-thinking":
      return renderRedactedThinking(item.label);
    case "tool-call":
      return renderToolCall(item.use, item.result, item.details);
    case "read-batch":
      return renderReadBatch(item.entries);
    case "card":
      return renderCard(item.card);
  }
}
