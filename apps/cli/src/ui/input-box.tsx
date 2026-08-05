import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { ACCENT_HEX, BASH_HEX, SELECTION_BG_HEX, sessionBadgeColor } from "../colors.js";
import { t } from "../i18n/index.js";
import { normalizeDroppedImagePath, type ClipboardPaste } from "../image-paste.js";
import { isCursorParking, setCursorTarget } from "./cursor-target.js";
import { setInputMouseController } from "./input-mouse.js";
import { charDisplayWidth, truncateToWidth, visibleWidth } from "./width.js";

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
   * Workspace file paths (relative, posix-style) offered for `@path` mention
   * completion. When the cursor sits inside an `@token`, a popup of matching
   * files appears; Tab/Enter completes the token to the selected path. Wired by
   * App.tsx from a snapshot the REPL refreshes after each turn.
   */
  files?: string[];
  /** Render typed characters as `*` (passwords / API keys). */
  mask?: boolean;
  /**
   * Previously-submitted user prompts for ↑/↓ recall, oldest first. Pressing ↑
   * walks backward into older entries (saving the in-progress draft first); ↓
   * walks forward and restores the draft past the newest entry. Wired by
   * App.tsx from the canonical message history with injected/tool messages
   * filtered out.
   */
  history?: string[];
  /**
   * Prompts queued while a turn is running, oldest first. Rendered dim above
   * the input so the user can see what will run next; never editable here.
   */
  queued?: string[];
  /**
   * Custom name for the active session (`/rename`). When set, it's shown as a
   * coloured badge on the right of the top frame. Only the permanent InputBox
   * wires this; modal/setup boxes leave it unset.
   */
  sessionName?: string;
}

export interface DisplayLine {
  content: string;
  bufStart: number;
  bufEnd: number;
  /**
   * True when this line is terminated by an explicit `\n` in the buffer (a
   * Shift+Enter hard break) rather than a soft width-wrap. The newline char
   * itself lives in the gap between this line's `bufEnd` and the next line's
   * `bufStart`, so it belongs to no line's content — but the caret may still sit
   * on it, which `findCursorPosition` resolves to the end of this line.
   */
  hardBreak?: boolean;
}

const POPUP_MAX_ROWS = 5;
const QUEUED_MAX_ROWS = 5;
/** Cap on file candidates fed to the mention popup before it scrolls. */
const MENTION_MAX_CANDIDATES = 50;
const RULE_CHAR = "┄";
const MIN_WIDTH = 20;
const PROMPT_TEXT = "❯ ";
const PROMPT_LEN = visibleWidth(PROMPT_TEXT);

/**
 * Clean text arriving from a keypress or the clipboard for the buffer: fold
 * CRLF/CR line endings to `\n` so pasted multi-line text keeps its breaks, then
 * strip every other control char (stray escape sequences must never land in the
 * buffer). Newlines survive because the buffer now renders them as hard breaks.
 */
export function sanitizePastedText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

export function wrapBuffer(buffer: string, width: number): DisplayLine[] {
  const firstCap = Math.max(1, width - 1 - PROMPT_LEN);
  const restCap = Math.max(1, width - 1);
  if (buffer.length === 0) {
    return [{ content: "", bufStart: 0, bufEnd: 0 }];
  }
  const lines: DisplayLine[] = [];
  let i = 0;
  while (i < buffer.length) {
    const cap = lines.length === 0 ? firstCap : restCap;
    let j = i;
    let used = 0;
    // Consume up to `cap` columns, stopping early at an explicit newline so it
    // forces a hard line break regardless of remaining width.
    while (j < buffer.length && buffer[j] !== "\n") {
      const w = charDisplayWidth(buffer, j);
      if (used + w > cap) break;
      used += w;
      j++;
    }
    if (j === i && buffer[i] !== "\n") j = i + 1; // forward progress (wide char at col 0)
    const hardBreak = buffer[j] === "\n";
    lines.push({ content: buffer.slice(i, j), bufStart: i, bufEnd: j, hardBreak });
    if (hardBreak) {
      i = j + 1; // skip the newline; it's part of no line's content
      // A trailing newline needs an explicit empty final line so the caret has a
      // row to land on after it.
      if (i === buffer.length) {
        lines.push({ content: "", bufStart: i, bufEnd: i });
      }
    } else {
      i = j;
    }
  }
  return lines;
}

export function findCursorPosition(
  lines: DisplayLine[],
  cursor: number,
): { row: number; col: number } {
  for (let li = 0; li < lines.length; li++) {
    const dl = lines[li];
    if (!dl) continue;
    // The last line, and any line ending in a hard `\n` break, own the caret
    // when it sits exactly at `bufEnd` (the newline offset) — that renders as the
    // end of this line rather than the start of the next. Soft-wrapped lines keep
    // the boundary offset on the following line's start.
    const ownsEnd = li === lines.length - 1 || dl.hardBreak === true;
    const inLine = ownsEnd ? cursor <= dl.bufEnd : cursor < dl.bufEnd;
    if (cursor >= dl.bufStart && inLine) {
      const col = visibleWidth(dl.content.slice(0, cursor - dl.bufStart));
      return { row: li, col };
    }
  }
  return { row: 0, col: 0 };
}

export interface InputHitLayout {
  /** Wrapped body lines (a single empty line when the buffer is empty). */
  lines: DisplayLine[];
  /** Rendered body row count — `lines.length`, or 1 for the empty placeholder. */
  bodyRows: number;
  /** Total terminal rows (from `cursorTracking`). */
  termRows: number;
  /** Chrome rows below the box: status line + mode indicator (`cursorTracking`). */
  bottomChromeRows: number;
}

/**
 * Map an absolute 1-indexed terminal `(row, col)` to a buffer offset, or null
 * when the point isn't on one of the input's body lines. The inverse of the
 * caret placement in render: a body line `li` sits at absolute row
 * `termRows - 1 - bottomChromeRows - (bodyRows - li)` (counted up from the
 * bottom-pinned frame), and its first content cell at column `2 + promptOffset`
 * (leading space + the `❯ ` prompt on the first line). The column is resolved to
 * a char boundary by walking display widths, so wide (CJK/emoji) chars map
 * correctly; a click past the line's end lands at its end.
 */
export function hitTestInput(layout: InputHitLayout, row: number, col: number): number | null {
  const { lines, bodyRows, termRows, bottomChromeRows } = layout;
  // rowForLine(li) = base + li, so li is recovered by subtracting the base.
  const base = termRows - 1 - bottomChromeRows - bodyRows;
  const li = row - base;
  if (li < 0 || li >= bodyRows) return null;
  const line = lines[li];
  if (!line) return null;
  const promptOffset = li === 0 ? PROMPT_LEN : 0;
  const visibleTarget = col - (2 + promptOffset);
  if (visibleTarget <= 0) return line.bufStart;
  let acc = 0;
  let k = 0;
  for (; k < line.content.length; k++) {
    const w = charDisplayWidth(line.content, k);
    if (visibleTarget < acc + w) break;
    acc += w;
  }
  return line.bufStart + k;
}

function matchingCommands(
  buffer: string,
  commands: SlashCommand[],
  dismissed: boolean,
): SlashCommand[] {
  if (dismissed || commands.length === 0) return [];
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
}

/**
 * The `@mention` token the cursor sits in, or null when there isn't one.
 *
 * A mention is a `@` that starts a whitespace-delimited word (so it's at the
 * buffer start or preceded by whitespace) followed by the path being typed.
 * `[start, end)` spans the whole `@…` word (which may extend past the cursor
 * when editing mid-token); `query` is just the path chars up to the cursor,
 * which is what we match files against. A leading `/` buffer is left to the
 * slash popup, so `@` mentions never fire on a command line.
 */
export function mentionTokenAt(
  buffer: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  if (buffer.startsWith("/")) return null;
  let start = cursor;
  while (start > 0 && !/\s/.test(buffer[start - 1] ?? "")) start--;
  if (buffer[start] !== "@") return null;
  let end = cursor;
  while (end < buffer.length && !/\s/.test(buffer[end] ?? "")) end++;
  return { start, end, query: buffer.slice(start + 1, cursor) };
}

/**
 * Rank workspace files for an `@mention` query. Basename-prefix matches rank
 * above basename-substring, then full-path substring; ties break on the
 * shorter, then lexically-smaller path. An empty query returns the shortest
 * paths first so a bare `@` still shows a useful starter list. Case-insensitive.
 */
export function matchingFiles(query: string, files: string[], limit: number): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (q.length === 0) score = 3;
    else if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else continue;
    scored.push({ path, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
  );
  return scored.slice(0, limit).map((s) => s.path);
}

/**
 * Buffer-coordinate range `[start, end)` of the leading `/command` token to
 * highlight in the input line, or null when there's nothing to highlight.
 *
 * Highlights the first whitespace-delimited token (e.g. `/agent` in
 * `/agent trace foo`) iff that token — minus its leading slash — is a prefix
 * of, or exactly equals, at least one registered command name. So a recognized
 * command (even mid-type, like `/ag`) lights up, while a typo (`/agentt`) or a
 * plain path (`/usr/bin`) stays unstyled, signalling "not a command".
 */
export function commandTokenRange(
  buffer: string,
  commands: SlashCommand[],
): [number, number] | null {
  if (commands.length === 0 || !buffer.startsWith("/")) return null;
  const word = /^\/(\S*)/.exec(buffer)?.[1] ?? "";
  if (word.length === 0) return null;
  const lc = word.toLowerCase();
  for (const c of commands) {
    const tail = c.name.startsWith("/") ? c.name.slice(1) : c.name;
    if (tail.toLowerCase().startsWith(lc)) return [0, 1 + word.length];
  }
  return null;
}

/**
 * Build the history-browse label embedded in a rule of exactly `width` columns:
 * `┄┄┄┄ History n/N ┄┄…`. Used for the left portion of the top frame while
 * walking ↑/↓ recall; sized to whatever width the session-name badge leaves.
 */
export function historyRule(width: number, pos: number, total: number): string {
  const label = t.input.history(pos, total);
  const lead = Math.min(4, Math.max(0, width));
  const trail = Math.max(0, width - lead - visibleWidth(label));
  return RULE_CHAR.repeat(lead) + label + RULE_CHAR.repeat(trail);
}

/** Rule chars left after the session-name badge, so it isn't flush-right. */
const SESSION_BADGE_TRAIL = 3;

/**
 * Lay out the session-name badge for the top frame: ` name ` padded by spaces,
 * with the rule filling the width on its left (`lead`) and a short fixed run of
 * rule chars on its right (`trail`) so it sits near — but not flush against —
 * the right edge: `┄┄┄ name ┄┄`. The name is truncated so the lead always keeps
 * at least one rule char, and lead + badge + trail span exactly `width` columns
 * (so the measured row count and frame alignment are unchanged). Returns null
 * when there's nothing to show.
 */
export function sessionNameBadge(
  name: string,
  width: number,
): { lead: string; badge: string; trail: string } | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  // Trail shrinks before the badge does on a narrow frame, and never eats the
  // last rule char on the left.
  const trailLen = Math.max(0, Math.min(SESSION_BADGE_TRAIL, width - 4));
  const badge = ` ${truncateToWidth(trimmed, Math.max(1, width - 3 - trailLen))} `;
  const lead = RULE_CHAR.repeat(Math.max(0, width - visibleWidth(badge) - trailLen));
  return { lead, badge, trail: RULE_CHAR.repeat(trailLen) };
}

/**
 * Render one display line as styled spans: the `/command` token (when within
 * `hl`) in the flame accent, cells within `sel` on the selection background, the
 * cursor cell inverted, everything else plain. Walks character by character and
 * coalesces runs that share styling so we emit as few `<Text>` nodes as possible.
 * `hl` and `sel` are buffer-coordinate `[start, end)` ranges.
 */
function styledSpans(
  content: string,
  lineBufStart: number,
  cursorCol: number | null,
  showCursorAtEnd: boolean,
  hl: [number, number] | null,
  sel: [number, number] | null,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = 0;
  let segStart = 0;
  let segHl = false;
  let segSel = false;
  const flush = (end: number): void => {
    if (end <= segStart) return;
    const slice = content.slice(segStart, end);
    nodes.push(
      <Text
        key={key++}
        color={segHl ? ACCENT_HEX : undefined}
        backgroundColor={segSel ? SELECTION_BG_HEX : undefined}
      >
        {slice}
      </Text>,
    );
    segStart = end;
  };
  for (let k = 0; k < content.length; k++) {
    const bufIdx = lineBufStart + k;
    const inHl = hl ? bufIdx >= hl[0] && bufIdx < hl[1] : false;
    const inSel = sel ? bufIdx >= sel[0] && bufIdx < sel[1] : false;
    if (cursorCol !== null && k === cursorCol) {
      flush(k);
      nodes.push(
        <Text key={key++} inverse>
          {content[k] ?? " "}
        </Text>,
      );
      segStart = k + 1;
      segHl = inHl;
      segSel = inSel;
      continue;
    }
    if (inHl !== segHl || inSel !== segSel) {
      flush(k);
      segHl = inHl;
      segSel = inSel;
    }
  }
  flush(content.length);
  if (showCursorAtEnd) {
    nodes.push(
      <Text key={key++} inverse>
        {" "}
      </Text>,
    );
  }
  return nodes;
}

interface LineSlice {
  content: string;
  cursorCol: number | null;
  showCursorAtEnd: boolean;
}

function buildLineWithCursor(line: DisplayLine, isCursorLine: boolean, cursor: number): LineSlice {
  if (!isCursorLine) {
    return { content: line.content, cursorCol: null, showCursorAtEnd: false };
  }
  const offsetInLine = cursor - line.bufStart;
  if (offsetInLine >= line.content.length) {
    return { content: line.content, cursorCol: null, showCursorAtEnd: true };
  }
  return { content: line.content, cursorCol: offsetInLine, showCursorAtEnd: false };
}

export interface InputBoxProps {
  options: BoxedInputOptions;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /**
   * Called whenever the InputBox's rendered row count changes (popup grows,
   * buffer wraps to more lines, etc.) so the parent can reserve enough rows
   * below the viewport instead of letting the popup overlap history.
   */
  onMeasure?: (rows: number) => void;
  /**
   * When false the InputBox stays mounted (buffer preserved) but ignores all
   * keystrokes — used while an in-stream modal (approval/ask/pick) owns input.
   * Defaults to true.
   */
  active?: boolean;
  /**
   * Called when Escape is pressed and there is no slash popup to dismiss. The
   * permanent InputBox wires this to interrupt a running turn; the modal
   * InputBox leaves it unset (Escape only closes the popup).
   */
  onEscape?: () => void;
  /**
   * Called on shift+tab to advance the permission mode. Only the permanent
   * InputBox wires this; without it shift+tab is a no-op (modal InputBoxes).
   */
  onCyclePermissionMode?: () => void;
  /**
   * Called when shell (`!`) mode toggles, so the host can surface a hint in the
   * status row. Only the permanent InputBox wires this; modal/setup InputBoxes
   * leave it unset (their `!` is just a literal character).
   */
  onShellModeChange?: (active: boolean) => void;
  /**
   * When set, the real terminal cursor is parked on this box's caret each frame
   * (so IME popups follow typing). Carries the layout context the box can't see
   * on its own: total terminal rows and the chrome rows below the box (status +
   * mode indicator). Only the permanent, bottom-pinned InputBox wires this;
   * modal/setup boxes leave it unset and don't drive the real cursor.
   */
  cursorTracking?: { termRows: number; bottomChromeRows: number };
  /**
   * Read the system clipboard for a Ctrl+V paste: an image (saved to a file, its
   * path returned) or plain text. Returning text lets Ctrl+V double as a normal
   * paste so it never eats input where Ctrl+V *is* the paste key (Windows). Host-
   * provided so platform/session logic stays out of the component; when unset,
   * Ctrl+V is a no-op.
   */
  onClipboardPaste?: () => Promise<ClipboardPaste | null>;
  /**
   * Called after an image path (clipboard or drag-drop) is inserted into the
   * buffer, so the host can confirm the attachment and warn when the active
   * model has no image-input modality. The path is still inserted regardless.
   */
  onImageAttached?: (path: string) => void;
}

export function InputBox({
  options,
  onSubmit,
  onCancel,
  onMeasure,
  active = true,
  onEscape,
  onCyclePermissionMode,
  onShellModeChange,
  cursorTracking,
  onClipboardPaste,
  onImageAttached,
}: InputBoxProps): React.ReactElement {
  const [buffer, setBuffer] = useState("");
  const [cursor, setCursor] = useState(0);
  const [popupCursor, setPopupCursor] = useState(0);
  const [popupOffset, setPopupOffset] = useState(0);
  const [popupDismissed, setPopupDismissed] = useState(false);
  // Mouse text selection, in buffer offsets. `anchor` is the press point, `head`
  // the latest drag point; null when nothing is selected. Driven entirely by the
  // Screen-level mouse handlers via the registered controller (see below); any
  // keystroke clears it. Normalised to `[lo, hi)` for rendering/copy.
  const [selection, setSelection] = useState<{ anchor: number; head: number } | null>(null);
  const { stdout } = useStdout();

  // Latest buffer/cursor for async inserts (clipboard capture resolves after the
  // keypress handler returns, so the closure's `buffer`/`cursor` would be stale)
  // and for the mouse controller, whose callbacks fire outside React's render.
  const bufferRef = useRef(buffer);
  const cursorRef = useRef(cursor);
  bufferRef.current = buffer;
  cursorRef.current = cursor;
  // Latest body layout for hit-testing mouse coordinates. Updated each render
  // (after the wrap is computed) so the controller's `hitTest` sees current rows.
  const layoutRef = useRef<InputHitLayout | null>(null);

  const width = Math.max(MIN_WIDTH, options.width ?? stdout?.columns ?? 80);
  const placeholderText = options.placeholder ?? "";
  const commands = options.commands ?? [];
  const files = options.files ?? [];
  const mask = options.mask ?? false;
  const history = options.history ?? [];
  const queued = options.queued ?? [];
  const sessionName = options.sessionName?.trim() ?? "";

  // Position into `history` for ↑/↓ recall. `history.length` means "not
  // browsing — the live draft buffer." `draft` preserves the in-progress text
  // while the user walks backward into older entries.
  const [historyPos, setHistoryPos] = useState(history.length);
  const [draft, setDraft] = useState("");

  // `history` is now sourced from a persisted store: it arrives asynchronously
  // at startup (empty → seeded) and grows on every submit. Re-pin the browse
  // position to the end whenever it changes so the seeded list is reachable and
  // the next ↑ always starts from the newest entry. History only changes via
  // this user's own submit (or the one-time seed), never mid-browse, so this
  // can't yank a recalled entry out from under them.
  const historyLen = history.length;
  useEffect(() => {
    setHistoryPos(historyLen);
  }, [historyLen]);

  // The completion popup is one of two kinds: slash commands when the buffer is
  // a command line, or `@path` file mentions when the cursor sits in an `@`
  // token. `matches` is the unified item list ({name, description}) the rest of
  // the component navigates and renders; `mention` carries the token range a
  // file pick replaces. Masked input (passwords) gets neither popup.
  const popup = (() => {
    if (mask || popupDismissed) return null;
    const cmds = matchingCommands(buffer, commands, false);
    if (cmds.length > 0) return { kind: "slash" as const, items: cmds, mention: null };
    if (files.length > 0) {
      const tok = mentionTokenAt(buffer, cursor);
      if (tok) {
        const paths = matchingFiles(tok.query, files, MENTION_MAX_CANDIDATES);
        if (paths.length > 0) {
          return {
            kind: "file" as const,
            items: paths.map((p) => ({ name: p, description: "" })),
            mention: { start: tok.start, end: tok.end },
          };
        }
      }
    }
    return null;
  })();
  const matches = popup?.items ?? [];
  // Highlight range for the leading `/command` token in the input line. Skipped
  // under mask (passwords) — we never colour asterisked input.
  const cmdRange = mask ? null : commandTokenRange(buffer, commands);
  const effectivePopupCursor = popupCursor >= matches.length ? 0 : popupCursor;
  const maxOffset = Math.max(0, matches.length - POPUP_MAX_ROWS);
  const safeOffset = Math.max(0, Math.min(popupOffset, maxOffset));

  const replaceBuffer = (next: string, nextCursor: number): void => {
    setBuffer(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
    setPopupDismissed(false);
    setPopupCursor(0);
    setPopupOffset(0);
    // Any edit drops a mouse selection and exits history-browse mode so the next
    // ↑ starts from the newest.
    setSelection(null);
    setHistoryPos(history.length);
  };

  // Insert text at the caret using the refs, so it stays correct when called
  // from an async clipboard continuation (which resolves after the keypress
  // handler returns, leaving the closed-over buffer/cursor stale).
  const insertAtCaret = (text: string): void => {
    const cur = bufferRef.current;
    const pos = cursorRef.current;
    replaceBuffer(cur.slice(0, pos) + text + cur.slice(pos), pos + text.length);
  };

  // Insert an image file path as a standalone, space-padded token so it reads as
  // one path the model can `read`.
  const insertImagePath = (path: string): void => {
    const before = bufferRef.current.slice(0, cursorRef.current);
    const lead = before.length > 0 && !before.endsWith(" ") ? " " : "";
    insertAtCaret(`${lead}${path} `);
  };

  // Insert pasted clipboard text. Strip control chars (matches typed-paste
  // handling below) so escape sequences never land in the buffer.
  const insertClipboardText = (text: string): void => {
    const clean = sanitizePastedText(text);
    if (clean.length > 0) insertAtCaret(clean);
  };

  // Drop a recalled history entry into the buffer without disturbing the
  // browse position. The slash popup stays suppressed so recall never pops it.
  const recall = (text: string): void => {
    setBuffer(text);
    setCursor(text.length);
    setPopupDismissed(true);
    setPopupCursor(0);
    setPopupOffset(0);
  };

  // Reset to an empty prompt after a submit (the permanent InputBox stays
  // mounted, so it can't rely on unmount to clear).
  const clearBuffer = (): void => {
    setBuffer("");
    setCursor(0);
    setPopupDismissed(false);
    setPopupCursor(0);
    setPopupOffset(0);
    setHistoryPos(history.length);
    setDraft("");
  };

  // Replace the `@…` token at `range` with `@path ` (trailing space so the
  // popup closes and the next word starts clean) and park the cursor after it.
  // Stays in edit mode — completing a mention never submits.
  const completeMention = (range: { start: number; end: number }, path: string): void => {
    const insert = `@${path} `;
    const next = buffer.slice(0, range.start) + insert + buffer.slice(range.end);
    setBuffer(next);
    setCursor(range.start + insert.length);
    setPopupDismissed(true);
    setPopupCursor(0);
    setPopupOffset(0);
    setHistoryPos(history.length);
  };

  const scrollPopupTo = (next: number): void => {
    if (next < safeOffset) {
      setPopupOffset(next);
    } else if (next >= safeOffset + POPUP_MAX_ROWS) {
      setPopupOffset(next - POPUP_MAX_ROWS + 1);
    }
  };

  // Register the mouse controller so the Screen-level handlers can move the caret
  // (click) and drive text selection (drag) on this box. Only the permanent,
  // bottom-pinned box (it wires `cursorTracking`) participates, and only while it
  // owns input — a modal taking over clears it so a click can't move a hidden
  // caret. Callbacks read refs because they fire outside React's render cycle.
  const mouseEnabled = !mask && !!cursorTracking;
  useEffect(() => {
    if (!mouseEnabled || !active) {
      setInputMouseController(null);
      return;
    }
    setInputMouseController({
      hitTest: (row, col) => (layoutRef.current ? hitTestInput(layoutRef.current, row, col) : null),
      moveCaret: (offset) => {
        setCursor(Math.max(0, Math.min(offset, bufferRef.current.length)));
        setSelection(null);
      },
      setRange: (range) => setSelection(range),
      textBetween: (lo, hi) => bufferRef.current.slice(lo, hi),
    });
    return () => setInputMouseController(null);
  }, [mouseEnabled, active]);

  useInput(
    (input, key) => {
      // Resolve a non-empty mouse selection to a `[lo, hi)` buffer range, captured
      // before any clearing below so a Backspace/Delete can act on it.
      const selLo = selection ? Math.min(selection.anchor, selection.head) : 0;
      const selHi = selection ? Math.max(selection.anchor, selection.head) : 0;
      const hasSelection = selHi > selLo;

      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }
      if (key.ctrl && input === "d") return;

      // Backspace/Delete with an active mouse selection removes the whole selection
      // (and parks the caret at its start) rather than a single char.
      if ((key.backspace || key.delete) && hasSelection) {
        replaceBuffer(buffer.slice(0, selLo) + buffer.slice(selHi), selLo);
        return;
      }
      // Any other keystroke drops a mouse selection (matches editor behaviour: the
      // next edit or caret move deselects). No-op when nothing is selected.
      if (selection) setSelection(null);

      // Shift+Enter inserts a literal newline instead of submitting, so a prompt
      // can span multiple lines. Terminals surface this in two forms Ink hands us
      // distinctly from a plain Enter: a bare line feed (`\n`, the common
      // Shift/Ctrl+Enter mapping — plain Enter is CR, `key.return`), or a modified
      // return that carries the shift bit (kitty/CSI-u keyboard protocol).
      if (input === "\n" || (key.return && key.shift)) {
        replaceBuffer(buffer.slice(0, cursor) + "\n" + buffer.slice(cursor), cursor + 1);
        return;
      }
      if (key.return) {
        // A selected file mention completes in place rather than submitting —
        // Enter inserts the path and keeps you typing.
        if (popup?.kind === "file") {
          const pick = matches[effectivePopupCursor];
          if (pick) {
            completeMention(popup.mention, pick.name);
            return;
          }
        }
        if (buffer.length === 0) return;
        // A selected slash command submits as that command; otherwise submit the
        // buffer verbatim.
        const pick = popup?.kind === "slash" ? matches[effectivePopupCursor] : undefined;
        const out = pick ? pick.name : buffer;
        onSubmit(out);
        clearBuffer();
        return;
      }
      // Ink 5 maps macOS Backspace (\x7f) to key.delete; treat both as backward delete.
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          replaceBuffer(buffer.slice(0, cursor - 1) + buffer.slice(cursor), cursor - 1);
        }
        return;
      }
      if (key.upArrow) {
        if (matches.length > 0) {
          const next = (effectivePopupCursor - 1 + matches.length) % matches.length;
          setPopupCursor(next);
          scrollPopupTo(next);
          return;
        }
        // Recall an older prompt. Save the live draft the first time we leave it.
        if (historyPos > 0) {
          if (historyPos === history.length) setDraft(buffer);
          const next = historyPos - 1;
          setHistoryPos(next);
          recall(history[next] ?? "");
        }
        return;
      }
      if (key.downArrow) {
        if (matches.length > 0) {
          const next = (effectivePopupCursor + 1) % matches.length;
          setPopupCursor(next);
          scrollPopupTo(next);
          return;
        }
        // Walk back toward newer prompts; past the newest, restore the draft.
        if (historyPos < history.length) {
          const next = historyPos + 1;
          setHistoryPos(next);
          recall(next === history.length ? draft : (history[next] ?? ""));
        }
        return;
      }
      // shift+tab cycles the permission mode. Ink reports it as tab+shift, so this
      // must run BEFORE the plain-tab autocomplete branch or that would swallow it.
      // Returns early regardless of popup state, so cycling works mid-popup too.
      if (key.tab && key.shift) {
        onCyclePermissionMode?.();
        return;
      }
      if (key.tab) {
        const pick = matches[effectivePopupCursor];
        if (pick) {
          if (popup?.kind === "file") {
            completeMention(popup.mention, pick.name);
          } else {
            setBuffer(pick.name);
            setCursor(pick.name.length);
            setPopupDismissed(true);
            setPopupCursor(0);
            setPopupOffset(0);
          }
        }
        return;
      }
      if (key.escape) {
        if (!popupDismissed && matches.length > 0) {
          setPopupDismissed(true);
          setPopupCursor(0);
          setPopupOffset(0);
          return;
        }
        onEscape?.();
        return;
      }
      if (key.leftArrow) {
        if (cursor > 0) setCursor(cursor - 1);
        return;
      }
      if (key.rightArrow) {
        if (buffer.length === 0 && placeholderText.length > 0) {
          replaceBuffer(placeholderText, placeholderText.length);
          return;
        }
        if (cursor < buffer.length) setCursor(cursor + 1);
        return;
      }
      if (key.ctrl && input === "a") {
        if (cursor !== 0) setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        if (cursor !== buffer.length) setCursor(buffer.length);
        return;
      }
      if (key.ctrl && input === "u") {
        if (cursor > 0) replaceBuffer(buffer.slice(cursor), 0);
        return;
      }
      if (key.ctrl && input === "k") {
        if (cursor < buffer.length) replaceBuffer(buffer.slice(0, cursor), cursor);
        return;
      }
      if (key.ctrl && input === "w") {
        if (cursor > 0) {
          const left = buffer.slice(0, cursor);
          const trimmed = left.replace(/\S*\s*$/, "");
          replaceBuffer(trimmed + buffer.slice(cursor), trimmed.length);
        }
        return;
      }
      // Ctrl+V: paste from the clipboard. An image (screenshot / copied image) is
      // saved to a file and inserted as its path; otherwise we fall back to the
      // clipboard text so Ctrl+V still works as a normal paste (notably on Windows,
      // where Ctrl+V *is* the paste key). On macOS, Cmd+V is owned by the terminal
      // and never reaches us, so Ctrl+V is the image gesture there.
      if (key.ctrl && input === "v") {
        if (onClipboardPaste) {
          void onClipboardPaste().then((res) => {
            if (!res) return;
            if (res.kind === "image") {
              insertImagePath(res.path);
              onImageAttached?.(res.path);
            } else {
              insertClipboardText(res.text);
            }
          });
        }
        return;
      }
      if (!input) return;
      // A drag-and-dropped image file arrives as a single pasted path chunk;
      // normalize it to a clean absolute path and treat it as an attachment.
      const dropped = normalizeDroppedImagePath(input);
      if (dropped) {
        insertImagePath(dropped);
        onImageAttached?.(dropped);
        return;
      }
      const text = sanitizePastedText(input);
      if (text.length === 0) return;
      replaceBuffer(buffer.slice(0, cursor) + text + buffer.slice(cursor), cursor + text.length);
    },
    { isActive: active },
  );

  const rule = RULE_CHAR.repeat(width);
  const isEmpty = buffer.length === 0;
  // Bash mode: a `!`-prefixed line runs in the shell rather than going to the
  // model. Recolour the top/bottom frame green so the mode is visible while
  // typing — never under mask (passwords).
  const bashMode = !mask && buffer.startsWith("!");
  // Surface shell mode to the host (status-row hint). Effect, not inline call,
  // so we only notify on an actual transition rather than every render.
  useEffect(() => {
    onShellModeChange?.(bashMode);
  }, [onShellModeChange, bashMode]);
  const lines = wrapBuffer(buffer, width);
  const { row: cursorRow, col: cursorCol } = isEmpty
    ? { row: 0, col: 0 }
    : findCursorPosition(lines, cursor);

  const popupVisible = Math.min(POPUP_MAX_ROWS, Math.max(0, matches.length - safeOffset));
  const popupTopMore = matches.length > 0 && safeOffset > 0 ? 1 : 0;
  const popupBottomMore =
    matches.length > 0 && safeOffset + POPUP_MAX_ROWS < matches.length ? 1 : 0;
  const popupRows = popupTopMore + popupVisible + popupBottomMore;
  const bodyRows = isEmpty ? 1 : lines.length;
  // Publish the body layout so the mouse controller's `hitTest` (which fires
  // outside render) maps coordinates against the rows on screen right now. Only
  // meaningful for the permanent box, which supplies `cursorTracking`.
  if (cursorTracking) {
    layoutRef.current = {
      lines,
      bodyRows,
      termRows: cursorTracking.termRows,
      bottomChromeRows: cursorTracking.bottomChromeRows,
    };
  }
  // Normalised selection range `[lo, hi)` in buffer coords for rendering. A
  // zero-width selection (anchor === head) paints nothing.
  const selRange: [number, number] | null =
    selection && selection.anchor !== selection.head
      ? selection.anchor < selection.head
        ? [selection.anchor, selection.head]
        : [selection.head, selection.anchor]
      : null;
  const queuedShown = queued.slice(0, QUEUED_MAX_ROWS);
  const queuedMoreRow = queued.length > QUEUED_MAX_ROWS ? 1 : 0;
  const queuedRows = queuedShown.length + queuedMoreRow;
  // While walking recall (↑/↓), label the top frame line with a "History
  // n/total" position — but not while a completion popup owns ↑/↓ (then they
  // navigate it). Embedded in the existing rule, so it adds no rows.
  const browsingHistory = matches.length === 0 && historyPos < history.length;
  // Session name badge (`/rename`), pinned near the right of the top frame with a
  // filled accent background and white text. Always shown when set — even while
  // browsing history: the History label takes the left of the line and the badge
  // the right. Suppressed only under mask (passwords).
  const nameBadge = !mask ? sessionNameBadge(sessionName, width) : null;
  // Left portion of the top frame: the History label while browsing, else a
  // plain rule. Sized to the width the badge leaves (full width when no badge),
  // so the label and the badge never overlap.
  const topLeftWidth = nameBadge ? nameBadge.lead.length : width;
  const topLeft = browsingHistory
    ? historyRule(topLeftWidth, historyPos + 1, history.length)
    : nameBadge
      ? nameBadge.lead
      : rule;
  // Frame styling. Bash mode tints the whole frame green (functional signal, so
  // it wins). Otherwise, when a session name is set, the frame rules adopt the
  // badge's colour so the border matches its background; with no name they stay
  // dim. `badgeColor` also fills the badge chip itself.
  const badgeColor = nameBadge ? sessionBadgeColor(sessionName) : null;
  const frameColor = bashMode ? BASH_HEX : (badgeColor ?? undefined);
  const frameDim = !bashMode && !badgeColor;
  const totalRows = queuedRows + popupRows + 2 + bodyRows;

  useEffect(() => {
    onMeasure?.(totalRows);
  }, [onMeasure, totalRows]);

  // Park the real terminal cursor on the caret so IME composition popups follow
  // typing. Computed during render (not an effect) so the value is in place for
  // the very frame Ink serializes from this tree — the stdout wrapper reads it
  // when it writes that frame. Coordinates are absolute and 1-indexed.
  //
  // Row: the box is pinned to the bottom, so we count up from the frame's last
  // row (termRows-1) past the chrome below the box (status + indicator) and the
  // box rows below the caret line — `bodyRows - cursorRow` covers the body lines
  // after the caret plus the bottom rule. Counting from the bottom keeps this
  // stable while the Viewport above reflows during streaming.
  // Col: leading space (col 1) + prompt (only on the first body line) + the
  // display width of the text before the caret, +1 to land on the caret cell.
  if (cursorTracking) {
    if (active) {
      const cols = stdout?.columns ?? width;
      const promptOffset = cursorRow === 0 ? PROMPT_LEN : 0;
      const row =
        cursorTracking.termRows - 1 - cursorTracking.bottomChromeRows - (bodyRows - cursorRow);
      const col = 2 + promptOffset + cursorCol;
      setCursorTarget({
        row: Math.max(1, Math.min(row, cursorTracking.termRows - 1)),
        col: Math.max(1, Math.min(col, cols)),
      });
    } else {
      // Permanent box still mounted but a modal owns input — drop the caret so
      // the cursor hides instead of lingering at a stale spot.
      setCursorTarget(null);
    }
  }

  // When the stdout wrapper is parking the real terminal cursor on this box's
  // caret (above), the terminal draws the caret itself — in the user's cursor
  // colour and shape. Drawing our inverse cell underneath it too would leave the
  // inverted (white) cell peeking out around the terminal's cursor block, so we
  // skip the fake caret and let the real one be the caret. Modal boxes (no
  // `cursorTracking`), an inactive box, and cursor-follow-off terminals get no
  // real caret, so they keep the inverse cell.
  const realCaret = !!cursorTracking && active && isCursorParking();

  const renderContentLine = (line: DisplayLine, idx: number): React.ReactElement => {
    const isCursorLine = idx === cursorRow && !realCaret;
    const slice = buildLineWithCursor(line, isCursorLine, cursor);
    const content = mask ? "*".repeat(slice.content.length) : slice.content;
    return (
      <Box key={idx}>
        <Text> </Text>
        {idx === 0 ? <Text color={BASH_HEX}>{PROMPT_TEXT}</Text> : null}
        {styledSpans(
          content,
          line.bufStart,
          slice.cursorCol,
          slice.showCursorAtEnd,
          cmdRange,
          mask ? null : selRange,
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      {queuedShown.map((q, i) => (
        <Text key={`q${i}`} dimColor>
          {` ↳ ${i + 1}. ${truncateToWidth(q.replace(/\s+/g, " ").trim(), Math.max(1, width - 6))}`}
        </Text>
      ))}
      {queuedMoreRow ? (
        <Text dimColor>{t.input.moreQueued(queued.length - QUEUED_MAX_ROWS)}</Text>
      ) : null}
      {matches.length > 0 && safeOffset > 0 ? (
        <Text dimColor> ↑ {t.input.moreAbove(safeOffset)}</Text>
      ) : null}
      {matches.slice(safeOffset, safeOffset + POPUP_MAX_ROWS).map((m, i) => {
        const absIndex = i + safeOffset;
        const isSel = absIndex === effectivePopupCursor;
        const arrow = isSel ? "❯ " : "  ";
        // Truncate the name to the box width so a long file path never wraps
        // (which would throw off the popup row count fed to onMeasure).
        const label = truncateToWidth(m.name, Math.max(10, width - 4));
        const nameWidth = Math.min(20, Math.max(...matches.map((mm) => visibleWidth(mm.name))));
        // Pad to align descriptions (slash commands). File rows carry no
        // description, so they need no padding.
        const pad = m.description
          ? " ".repeat(Math.max(1, nameWidth + 2 - visibleWidth(label)))
          : "";
        return (
          <Text key={m.name} color={isSel ? ACCENT_HEX : undefined} dimColor={!isSel}>
            {arrow}
            {label}
            {pad}
            {m.description}
          </Text>
        );
      })}
      {matches.length > 0 && safeOffset + POPUP_MAX_ROWS < matches.length ? (
        <Text dimColor> ↓ {matches.length - safeOffset - POPUP_MAX_ROWS} more</Text>
      ) : null}
      {nameBadge ? (
        <Box>
          <Text dimColor={frameDim} color={frameColor}>
            {topLeft}
          </Text>
          <Text backgroundColor={badgeColor ?? undefined} color="white" bold>
            {nameBadge.badge}
          </Text>
          <Text dimColor={frameDim} color={frameColor}>
            {nameBadge.trail}
          </Text>
        </Box>
      ) : (
        <Text dimColor={frameDim} color={frameColor}>
          {topLeft}
        </Text>
      )}
      {isEmpty ? (
        <Box>
          <Text> </Text>
          <Text color={BASH_HEX}>{PROMPT_TEXT}</Text>
          {realCaret ? <Text> </Text> : <Text inverse> </Text>}
          {placeholderText ? <Text dimColor>{placeholderText}</Text> : null}
        </Box>
      ) : (
        lines.map(renderContentLine)
      )}
      <Text dimColor={frameDim} color={frameColor}>
        {rule}
      </Text>
    </Box>
  );
}
