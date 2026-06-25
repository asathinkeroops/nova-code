import type { ToolResultBlock, ToolUseBlock } from "@nova/core";
import { aliasedPath } from "@nova/tools";
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
} from "../colors.js";
import { LOGO, bannerLine } from "./logo.js";
import {
  COMPACT_MAX_LINES,
  compactBody,
  readExisting,
  renderDiff,
  renderFileContent,
  splitDisplayLines,
} from "./diff.js";
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

function displayCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

function formatModel(b: BannerProps): string {
  const base = b.contextWindowSize
    ? (() => {
        const window =
          b.contextWindowSize >= 1_000_000
            ? `${Math.round(b.contextWindowSize / 1_000_000)}m`
            : b.contextWindowSize >= 1_000
              ? `${Math.round(b.contextWindowSize / 1_000)}k`
              : `${b.contextWindowSize}`;
        return `${b.model}[${window}]`;
      })()
    : b.model;
  return b.thinkingLabel ? `${base} with ${accent(bold(b.thinkingLabel))} effort` : base;
}

function renderBanner(b: BannerProps, width: number): string {
  void width;
  const lines: string[] = [""];
  lines.push(`${accent(">_")} Nova Code ${dim(`(v${b.version})`)}`);
  lines.push("");
  LOGO.forEach((l, i) => lines.push(bannerLine(l, i)));
  lines.push("");
  lines.push(dim("The coding agent purpose-built for DeepSeek — 95%+ cache hits · OS-sandboxed · tool-complete · install-and-go. "));
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

// Wrap committed reasoning to the gutter body width. Hard-wrapped so the line
// count is stable (measure re-wraps to the same width without splitting again),
// which lets {@link thinkingToggleLineIndex} locate the hint row analytically.
function wrapThinkingBody(text: string, width: number): string[] {
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.length === 0) return [];
  const bodyWidth = Math.max(1, width - THINKING_INDENT.length);
  return wrapAnsi(trimmed, bodyWidth, { hard: true, wordWrap: false, trim: false }).split("\n");
}

function renderThinking(
  text: string,
  label: string | undefined,
  width: number,
  collapsed = false,
  expanded = false,
): string {
  const head = `${magenta("✻")} ${dim(`thinking${label ? ` · ${label}` : ""}`)}`;
  const lines = wrapThinkingBody(text, width);
  if (lines.length === 0) return head;
  // Once thinking is done we collapse it to a short preview: the first few
  // wrapped rows plus a one-line hint counting what was hidden. The user can
  // click that hint to expand the full reasoning (which then ends in a
  // "show less" hint to collapse again). While streaming (collapsed === false)
  // the full reasoning is always shown with no hint.
  const overflow = collapsed ? Math.max(0, lines.length - THINKING_COLLAPSED_MAX_LINES) : 0;
  const shown = overflow > 0 && !expanded ? lines.slice(0, THINKING_COLLAPSED_MAX_LINES) : lines;
  const body = shown
    .map((line, i) => `${dim(i === 0 ? "  ⎿  " : THINKING_INDENT)}${dim(italic(line))}`)
    .join("\n");
  if (overflow > 0) {
    const hint = expanded ? "… show less" : `… +${overflow} lines`;
    return `${head}\n${body}\n${dim(`${THINKING_INDENT}${hint}`)}`;
  }
  return `${head}\n${body}`;
}

/**
 * Index of a committed thinking block's clickable hint row (the "… +N lines" /
 * "… show less" control), or null when the block has no hint (still streaming,
 * empty, or its body fits the preview). The hint is always the last rendered
 * row: header (1) + preview/full body rows + the hint. Used by `measure` to map
 * that row to a click/hover target.
 */
export function thinkingToggleLineIndex(
  item: Extract<RenderItem, { kind: "thinking" }>,
  width: number,
): number | null {
  if (item.collapsed !== true) return null;
  const lines = wrapThinkingBody(item.thinking, width);
  if (lines.length <= THINKING_COLLAPSED_MAX_LINES) return null;
  const shown = item.expanded ? lines.length : THINKING_COLLAPSED_MAX_LINES;
  return 1 + shown; // header at 0, body rows 1..shown, hint immediately after
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
  /**
   * Raw multi-line body (command / diff / file content) shown as child rows
   * under the header's `⎿` gutter. Rendered uniformly by {@link renderToolCall}
   * via {@link gutterIndent}, so individual tools return it un-guttered; plain
   * text should be pre-wrapped with {@link wrapBodyToWidth} for aligned wrapping.
   */
  body?: string;
}

interface ToolStr {
  use?(input: Record<string, unknown>, width: number): UseView;
  result?(result: ToolResultBlock, input: Record<string, unknown> | undefined): string;
}

/**
 * Hang a multi-line body under a single `⎿` child gutter, mirroring the thinking
 * block: the first row carries the elbow, every continuation row aligns under it
 * at {@link THINKING_INDENT}. The body is taken as-is (already wrapped / styled);
 * use {@link wrapBodyToWidth} first for plain text that needs aligned wrapping.
 */
function gutterIndent(body: string): string {
  return body
    .split("\n")
    .map((line, i) => `${dim(i === 0 ? "  ⎿  " : THINKING_INDENT)}${line}`)
    .join("\n");
}

/**
 * Hard-wrap each logical line of plain text to the gutter body width so long
 * lines stay aligned under the gutter instead of falling back to column 0. ANSI
 * styled bodies (diffs / highlighted file content) are already laid out and skip
 * this — they go straight to {@link gutterIndent}.
 */
function wrapBodyToWidth(text: string, width: number): string {
  const trimmed = text.replace(/\s+$/u, "");
  const bodyWidth = Math.max(1, width - THINKING_INDENT.length);
  const visual: string[] = [];
  for (const logical of trimmed.split("\n")) {
    visual.push(
      ...wrapAnsi(logical, bodyWidth, { hard: true, wordWrap: false, trim: false }).split("\n"),
    );
  }
  return visual.join("\n");
}

/**
 * Render a command (long or multi-line) as `⎿`-gutter child rows. Used by the
 * approval prompt to preview a bash command exactly as the transcript prints it.
 */
export function renderCommandBody(cmd: string, width: number): string {
  return gutterIndent(wrapBodyToWidth(cmd, width));
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
    use: (input, width) => {
      const cmd = typeof input.command === "string" ? input.command : JSON.stringify(input);
      // Keep the header a single clean row (`● bash`) and show the command as a
      // child node under the `⎿` gutter, like a thinking block. Heredocs and
      // long one-liners stay readable instead of being flattened/truncated into
      // the header. Pre-wrap to the body width so continuation rows stay aligned;
      // renderToolCall adds the gutter.
      return { header: header("bash"), body: wrapBodyToWidth(cmd, width) };
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
    use: (input) => {
      const path = aliasedPath(input) ?? "?";
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
    use: (input) => {
      const path = aliasedPath(input) ?? "?";
      const content = typeof input.content === "string" ? input.content : "";
      const existing = readExisting(path);
      const lines = content.length === 0 ? 0 : content.split("\n").length;
      const verb = existing !== null ? "overwrite" : "write";
      const meta = `(${content.length} bytes · ${lines} line${lines === 1 ? "" : "s"})`;
      const h = header(verb, `${path} ${dim(meta)}`);
      if (content.length === 0 && existing === null) return { header: h };
      const body =
        existing !== null ? renderDiff(existing, content, path) : renderFileContent(content, path);
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
      return { header: header("ask", dim(headers || `${qs.length} question(s)`)) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      return okLine(flatten(trim(contentToString(result.content), 200)));
    },
  },
  edit: {
    use: (input) => {
      const path = aliasedPath(input) ?? "?";
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
    use: (input) => {
      const name = typeof input.name === "string" ? input.name : "?";
      return { header: header("skill", name) };
    },
    result: (result) => {
      if (result.is_error) return errLine(result);
      return okLine(formatBytes(contentToString(result.content).length));
    },
  },
  runInBackground: {
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
    use: (input) => {
      const description = typeof input.description === "string" ? input.description : "sub-agent";
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

/**
 * Body presentation for a body-bearing tool call. While pending (`done` ===
 * false) the body shows in full. Once done, a body longer than
 * {@link COMPACT_MAX_LINES} collapses to a short preview ending in a clickable
 * hint (`compactBody`); when the user has expanded it, the full body shows
 * followed by a `… show less` hint to collapse again. The hint is always the
 * last line of the returned body, which {@link toolCallToggleLineIndex} relies
 * on to locate the click target.
 */
function toolBodyView(body: string, done: boolean, expanded: boolean): string {
  if (!done || body.split("\n").length <= COMPACT_MAX_LINES) return body;
  return expanded ? `${body}\n${dim("… show less")}` : compactBody(body);
}

function renderToolCall(
  use: ToolUseBlock,
  result: ToolResultBlock | undefined,
  width: number,
  details?: SubAgentDetail[],
  expanded = false,
): string {
  const def = tools[use.name];
  const view: UseView = def?.use
    ? def.use(use.input as Record<string, unknown>, width)
    : { header: genericUseHeader(use) };
  const head = `${marker(toolState(result))} ${view.header}`;
  const detailRows = renderSubAgentDetails(details);

  // Title + child nodes, mirroring a thinking block: a clean header row, with
  // its detail (body and/or result) hanging underneath as children under a
  // single `⎿` elbow. Nothing is ever collapsed onto the title line, so every
  // tool call reads the same way.
  const resultStr =
    result === undefined
      ? undefined
      : def?.result
        ? def.result(result, use.input as Record<string, unknown> | undefined)
        : result.is_error
          ? errLine(result)
          : okLine(flatten(trim(contentToString(result.content), 200)));

  // Body-bearing tools (bash command, edit/write diff or file content): hang the
  // body under a single `⎿` gutter and let the result join it as one more
  // aligned continuation row — one elbow total, exactly like a thinking block.
  // The body collapses to a short preview once the call is done, with a trailing
  // hint the user can click to expand the full body (and again to collapse);
  // while pending it shows in full and the blinking marker dot signals progress.
  if (view.body) {
    const gut = gutterIndent(toolBodyView(view.body, resultStr !== undefined, expanded));
    if (resultStr === undefined) return `${head}\n${gut}${detailRows}`;
    return `${head}\n${gut}\n${THINKING_INDENT}${resultStr}${detailRows}`;
  }

  // Body-less tools: the result is the elbow child (a `⎿ …` placeholder while
  // pending).
  const child = resultStr === undefined ? dim("…") : resultStr;
  return `${head}\n  ${dim("⎿")}  ${child}${detailRows}`;
}

// ─── tool batch ──────────────────────────────────────────────────────────────

type BatchMember = { use: ToolUseBlock; result: ToolResultBlock | undefined };

/**
 * One-line summary of a folded tool batch, e.g.
 * `Search 2 patterns, read 3 files, run 1 shell command`. Searches (grep/glob),
 * reads, and runs (bash) are counted into fixed-order segments; only the first
 * segment keeps its leading capital so the line reads as a sentence.
 */
export function toolBatchSummary(members: BatchMember[]): string {
  let search = 0;
  let read = 0;
  let run = 0;
  for (const m of members) {
    const name = m.use.name;
    if (name === "grep" || name === "glob") search++;
    else if (name === "read") read++;
    else if (name === "bash") run++;
  }
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
  const segs: string[] = [];
  if (search > 0) segs.push(`Search ${plural(search, "pattern")}`);
  if (read > 0) segs.push(`Read ${plural(read, "file")}`);
  if (run > 0) segs.push(`Run ${plural(run, "shell command")}`);
  return segs
    .map((s, i) => (i === 0 ? s : `${s.charAt(0).toLowerCase()}${s.slice(1)}`))
    .join(", ");
}

// Left spine that visually wraps an expanded batch's children under the title,
// aligning the bar under the disclosure triangle. Two visual columns ("│ ") so
// children render against `width - 2` and the prefix never forces a re-wrap.
const BATCH_GUTTER = `${dim("│")} `;
const BATCH_GUTTER_W = 2;

/**
 * Aggregate state of a batch: pending while any member is still running, then
 * error if any failed, else ok. Drives the disclosure marker colour so a
 * streaming batch reads as in-progress without the line re-flowing.
 */
function batchState(members: BatchMember[]): ToolState {
  if (members.some((m) => m.result === undefined)) return "pending";
  if (members.some((m) => m.result?.is_error === true)) return "err";
  return "ok";
}

function renderToolBatch(
  members: BatchMember[],
  collapsed: boolean,
  width: number,
): string {
  // Disclosure triangle (▸ collapsed / ▾ expanded) signals the row is clickable;
  // its colour mirrors the aggregate state (gray pending / red error / green ok),
  // like a tool marker dot.
  const state = batchState(members);
  const tri = collapsed ? "▸" : "▾";
  const tinted = state === "pending" ? gray(tri) : state === "err" ? red(tri) : green(tri);
  const summary = toolBatchSummary(members);
  // Collapsed batches are summaries the eye should skim past; dim the text so
  // they recede behind real content (only the coloured triangle stays vivid).
  // Expanded, the title heads a visible group, so it stays full-strength.
  if (collapsed) return `${tinted} ${dim(summary)}`;
  const title = `${tinted} ${summary}`;
  // Expanded: the title, then every member rendered exactly as an un-batched
  // tool call but hung off a continuous left spine (│) so the children read as
  // one group owned by the title. Members are separated by a bar-only row and
  // the group is closed with a `╰` corner.
  const childWidth = Math.max(1, width - BATCH_GUTTER_W);
  const lines = [title];
  members.forEach((m, i) => {
    if (i > 0) lines.push(dim("│"));
    for (const ln of renderToolCall(m.use, m.result, childWidth).split("\n")) {
      lines.push(`${BATCH_GUTTER}${ln}`);
    }
  });
  lines.push(dim("╰"));
  return lines.join("\n");
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
      return renderThinking(
        item.thinking,
        item.label,
        width,
        item.collapsed ?? false,
        item.expanded ?? false,
      );
    case "redacted-thinking":
      return renderRedactedThinking(item.label);
    case "tool-call":
      return renderToolCall(item.use, item.result, width, item.details, item.expanded ?? false);
    case "tool-batch":
      return renderToolBatch(item.members, item.collapsed, width);
    case "card":
      return renderCard(item.card);
  }
}

/**
 * Index of a body-bearing tool call's clickable hint row (the trailing
 * "… N more lines hidden" / "… show less" control), or null when the call has
 * no collapsible body — still pending, body-less, or a body that fits the
 * preview. The hint is the last line of the gutter body, so everything up to and
 * including it is `head + gut` and the hint is its final wrapped row. Wrapping
 * matches `measureItem` so the index lands on the same row the viewport shows.
 */
export function toolCallToggleLineIndex(
  item: Extract<RenderItem, { kind: "tool-call" }>,
  width: number,
): number | null {
  if (item.result === undefined) return null;
  const def = tools[item.use.name];
  const view: UseView = def?.use
    ? def.use(item.use.input as Record<string, unknown>, width)
    : { header: genericUseHeader(item.use) };
  if (!view.body || view.body.split("\n").length <= COMPACT_MAX_LINES) return null;
  const head = `${marker(toolState(item.result))} ${view.header}`;
  const gut = gutterIndent(toolBodyView(view.body, true, item.expanded ?? false));
  return wrappedRowCount(`${head}\n${gut}`, width) - 1;
}

// Count the rows an ANSI string occupies when hard-wrapped to `width`, matching
// `measureItem`'s wrapping (hard, no word-wrap, preserve leading space). Kept
// local to avoid a render-strings ↔ measure import cycle.
function wrappedRowCount(s: string, width: number): number {
  return wrapAnsi(s, Math.max(1, width), { hard: true, wordWrap: false, trim: false }).split("\n")
    .length;
}

/**
 * Index of the click/hover target row within an item's rendered lines, or null
 * if the item has none. A tool batch's whole title is the control (row 0); a
 * collapsed thinking block's control is its trailing "… +N lines" / "show less"
 * hint; a body-bearing tool call's control is its trailing collapse/expand hint.
 * `measure` uses this to map a viewport row back to a collapsible item.
 */
export function clickTargetLine(item: RenderItem, width: number): number | null {
  switch (item.kind) {
    case "tool-batch":
      return 0;
    case "thinking":
      return thinkingToggleLineIndex(item, width);
    case "tool-call":
      return toolCallToggleLineIndex(item, width);
    default:
      return null;
  }
}
