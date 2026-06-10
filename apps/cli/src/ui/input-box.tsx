import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { ACCENT_HEX, BASH_HEX } from "../colors.js";
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
}

interface DisplayLine {
  content: string;
  bufStart: number;
  bufEnd: number;
}

const POPUP_MAX_ROWS = 5;
const QUEUED_MAX_ROWS = 5;
/** Cap on file candidates fed to the mention popup before it scrolls. */
const MENTION_MAX_CANDIDATES = 50;
const RULE_CHAR = "┄";
const MIN_WIDTH = 20;
const PROMPT_TEXT = "› ";
const PROMPT_LEN = visibleWidth(PROMPT_TEXT);

function wrapBuffer(buffer: string, width: number): DisplayLine[] {
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
    while (j < buffer.length) {
      const w = charDisplayWidth(buffer, j);
      if (used + w > cap) break;
      used += w;
      j++;
    }
    if (j === i) j = i + 1; // forward progress
    lines.push({ content: buffer.slice(i, j), bufStart: i, bufEnd: j });
    i = j;
  }
  return lines;
}

function findCursorPosition(
  lines: DisplayLine[],
  cursor: number,
): { row: number; col: number } {
  for (let li = 0; li < lines.length; li++) {
    const dl = lines[li];
    if (!dl) continue;
    const inLine = li === lines.length - 1 ? cursor <= dl.bufEnd : cursor < dl.bufEnd;
    if (cursor >= dl.bufStart && inLine) {
      const col = visibleWidth(dl.content.slice(0, cursor - dl.bufStart));
      return { row: li, col };
    }
  }
  return { row: 0, col: 0 };
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
    (a, b) =>
      a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
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
 * Render one display line as styled spans: the `/command` token (when within
 * `hl`) in the flame accent, the cursor cell inverted, everything else plain.
 * Walks character by character and coalesces runs that share styling so we
 * emit as few `<Text>` nodes as possible.
 */
function styledSpans(
  content: string,
  lineBufStart: number,
  cursorCol: number | null,
  showCursorAtEnd: boolean,
  hl: [number, number] | null,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = 0;
  let segStart = 0;
  let segHl = false;
  const flush = (end: number): void => {
    if (end <= segStart) return;
    const slice = content.slice(segStart, end);
    nodes.push(
      <Text key={key++} color={segHl ? ACCENT_HEX : undefined}>
        {slice}
      </Text>,
    );
    segStart = end;
  };
  for (let k = 0; k < content.length; k++) {
    const bufIdx = lineBufStart + k;
    const inHl = hl ? bufIdx >= hl[0] && bufIdx < hl[1] : false;
    if (cursorCol !== null && k === cursorCol) {
      flush(k);
      nodes.push(
        <Text key={key++} inverse>
          {content[k] ?? " "}
        </Text>,
      );
      segStart = k + 1;
      segHl = inHl;
      continue;
    }
    if (inHl !== segHl) {
      flush(k);
      segHl = inHl;
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

function buildLineWithCursor(
  line: DisplayLine,
  isCursorLine: boolean,
  cursor: number,
): LineSlice {
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
}

export function InputBox({
  options,
  onSubmit,
  onCancel,
  onMeasure,
  active = true,
  onEscape,
  onCyclePermissionMode,
}: InputBoxProps): React.ReactElement {
  const [buffer, setBuffer] = useState("");
  const [cursor, setCursor] = useState(0);
  const [popupCursor, setPopupCursor] = useState(0);
  const [popupOffset, setPopupOffset] = useState(0);
  const [popupDismissed, setPopupDismissed] = useState(false);
  const { stdout } = useStdout();

  const width = Math.max(MIN_WIDTH, options.width ?? stdout?.columns ?? 80);
  const placeholderText = options.placeholder ?? "";
  const commands = options.commands ?? [];
  const files = options.files ?? [];
  const mask = options.mask ?? false;
  const history = options.history ?? [];
  const queued = options.queued ?? [];

  // Position into `history` for ↑/↓ recall. `history.length` means "not
  // browsing — the live draft buffer." `draft` preserves the in-progress text
  // while the user walks backward into older entries.
  const [historyPos, setHistoryPos] = useState(history.length);
  const [draft, setDraft] = useState("");

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
    // Any edit exits history-browse mode so the next ↑ starts from the newest.
    setHistoryPos(history.length);
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

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (key.ctrl && input === "d") return;

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
        recall(next === history.length ? draft : history[next] ?? "");
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
    if (!input) return;
    // eslint-disable-next-line no-control-regex
    const text = input.replace(/[\x00-\x1f]/g, "");
    if (text.length === 0) return;
    replaceBuffer(buffer.slice(0, cursor) + text + buffer.slice(cursor), cursor + text.length);
  }, { isActive: active });

  const rule = RULE_CHAR.repeat(width);
  const isEmpty = buffer.length === 0;
  // Bash mode: a `!`-prefixed line runs in the shell rather than going to the
  // model. Recolour the top/bottom frame green so the mode is visible while
  // typing — never under mask (passwords).
  const bashMode = !mask && buffer.startsWith("!");
  const lines = wrapBuffer(buffer, width);
  const { row: cursorRow } = isEmpty ? { row: 0 } : findCursorPosition(lines, cursor);

  const popupVisible = Math.min(POPUP_MAX_ROWS, Math.max(0, matches.length - safeOffset));
  const popupTopMore = matches.length > 0 && safeOffset > 0 ? 1 : 0;
  const popupBottomMore =
    matches.length > 0 && safeOffset + POPUP_MAX_ROWS < matches.length ? 1 : 0;
  const popupRows = popupTopMore + popupVisible + popupBottomMore;
  const bodyRows = isEmpty ? 1 : lines.length;
  const queuedShown = queued.slice(0, QUEUED_MAX_ROWS);
  const queuedMoreRow = queued.length > QUEUED_MAX_ROWS ? 1 : 0;
  const queuedRows = queuedShown.length + queuedMoreRow;
  const totalRows = queuedRows + popupRows + 2 + bodyRows;

  useEffect(() => {
    onMeasure?.(totalRows);
  }, [onMeasure, totalRows]);

  const renderContentLine = (line: DisplayLine, idx: number): React.ReactElement => {
    const isCursorLine = idx === cursorRow;
    const slice = buildLineWithCursor(line, isCursorLine, cursor);
    const content = mask ? "*".repeat(slice.content.length) : slice.content;
    return (
      <Box key={idx}>
        <Text>{" "}</Text>
        {idx === 0 ? <Text color={ACCENT_HEX}>{PROMPT_TEXT}</Text> : null}
        {styledSpans(content, line.bufStart, slice.cursorCol, slice.showCursorAtEnd, cmdRange)}
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
        <Text dimColor>{` ↳ +${queued.length - QUEUED_MAX_ROWS} more queued`}</Text>
      ) : null}
      {matches.length > 0 && safeOffset > 0 ? (
        <Text dimColor> ↑ {safeOffset} more</Text>
      ) : null}
      {matches.slice(safeOffset, safeOffset + POPUP_MAX_ROWS).map((m, i) => {
        const absIndex = i + safeOffset;
        const isSel = absIndex === effectivePopupCursor;
        const arrow = isSel ? "❯ " : "  ";
        // Truncate the name to the box width so a long file path never wraps
        // (which would throw off the popup row count fed to onMeasure).
        const label = truncateToWidth(m.name, Math.max(10, width - 4));
        const nameWidth = Math.min(
          20,
          Math.max(...matches.map((mm) => visibleWidth(mm.name))),
        );
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
      <Text dimColor={!bashMode} color={bashMode ? BASH_HEX : undefined}>
        {rule}
      </Text>
      {isEmpty ? (
        <Box>
          <Text> </Text>
          <Text color={ACCENT_HEX}>{PROMPT_TEXT}</Text>
          <Text inverse> </Text>
          {placeholderText ? <Text dimColor>{placeholderText}</Text> : null}
        </Box>
      ) : (
        lines.map(renderContentLine)
      )}
      <Text dimColor={!bashMode} color={bashMode ? BASH_HEX : undefined}>
        {rule}
      </Text>
    </Box>
  );
}

