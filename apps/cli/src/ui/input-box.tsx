import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
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
}

export function InputBox({
  options,
  onSubmit,
  onCancel,
  onMeasure,
  active = true,
  onEscape,
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
  const mask = options.mask ?? false;
  const history = options.history ?? [];
  const queued = options.queued ?? [];

  // Position into `history` for ↑/↓ recall. `history.length` means "not
  // browsing — the live draft buffer." `draft` preserves the in-progress text
  // while the user walks backward into older entries.
  const [historyPos, setHistoryPos] = useState(history.length);
  const [draft, setDraft] = useState("");

  const matches = matchingCommands(buffer, commands, popupDismissed);
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
      if (buffer.length === 0) return;
      const pick = matches[effectivePopupCursor];
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
    if (key.tab) {
      const pick = matches[effectivePopupCursor];
      if (pick) {
        setBuffer(pick.name);
        setCursor(pick.name.length);
        setPopupDismissed(true);
        setPopupCursor(0);
        setPopupOffset(0);
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
        {idx === 0 ? <Text color="cyan">{PROMPT_TEXT}</Text> : null}
        {slice.cursorCol === null ? (
          <Text>{content}</Text>
        ) : (
          <>
            <Text>{content.slice(0, slice.cursorCol)}</Text>
            <Text inverse>{content[slice.cursorCol] ?? " "}</Text>
            <Text>{content.slice(slice.cursorCol + 1)}</Text>
          </>
        )}
        {slice.showCursorAtEnd ? <Text inverse> </Text> : null}
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
        const nameWidth = Math.min(
          20,
          Math.max(...matches.map((mm) => visibleWidth(mm.name))),
        );
        const pad = " ".repeat(Math.max(1, nameWidth + 2 - visibleWidth(m.name)));
        return (
          <Text key={m.name} color={isSel ? "cyan" : undefined} dimColor={!isSel}>
            {arrow}
            {m.name}
            {pad}
            {m.description}
          </Text>
        );
      })}
      {matches.length > 0 && safeOffset + POPUP_MAX_ROWS < matches.length ? (
        <Text dimColor> ↓ {matches.length - safeOffset - POPUP_MAX_ROWS} more</Text>
      ) : null}
      <Text dimColor>{rule}</Text>
      {isEmpty ? (
        <Box>
          <Text> </Text>
          <Text color="cyan">{PROMPT_TEXT}</Text>
          <Text inverse> </Text>
          {placeholderText ? <Text dimColor>{placeholderText}</Text> : null}
        </Box>
      ) : (
        lines.map(renderContentLine)
      )}
      <Text dimColor>{rule}</Text>
    </Box>
  );
}

