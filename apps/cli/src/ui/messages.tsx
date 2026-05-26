import React from "react";
import { Box, Text, useStdout } from "ink";
import {
  blocksOf,
  extractText,
  type ContentBlock,
  type MessageParam,
  type ToolResultBlock,
} from "@nova/core";
import { blue, bold, orange, red } from "../colors.js";
import { renderMarkdown } from "./markdown.js";
import type { Card } from "./store.js";
import { RedactedThinkingBlock, ThinkingBlock } from "./thinking.js";
import { ToolCall } from "./tool-call.js";
import { visibleWidth } from "./width.js";

const USER_BUBBLE_BG = "#3a3a3a";

/**
 * Hook-injected user-role messages (todo/task reminders, long-running command
 * notifications) are not real user input — they should not render as user
 * bubbles in the transcript. Each injection wraps its payload in a known tag
 * so we can detect it by prefix.
 */
function isSystemInjectionText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<reminder>") ||
    trimmed.startsWith("<long-running-command")
  );
}

/**
 * Bookkeeping tools the user doesn't need to see — todo/task updates show up
 * in the footer, and long-running status polls are pure agent-side telemetry.
 * Their tool_use / tool_result rows are hidden from the transcript.
 */
function isHiddenTool(name: string): boolean {
  return (
    name === "createTodo" ||
    name === "updateTodo" ||
    name === "getTodoList" ||
    name === "clearTodoList" ||
    name === "createTask" ||
    name === "updateTask" ||
    name === "getTask" ||
    name === "getTaskList" ||
    name === "clearTaskList" ||
    name === "checkLongRunningCommand"
  );
}

function buildResultIndex(messages: MessageParam[]): Map<string, ToolResultBlock> {
  const idx = new Map<string, ToolResultBlock>();
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") idx.set(b.tool_use_id, b);
    }
  }
  return idx;
}

export interface MessagesProps {
  messages: MessageParam[];
  /**
   * Inline UI cards interleaved with messages by anchor. Cards with
   * `anchor === -1` render before all messages; otherwise a card renders
   * immediately after `messages[anchor]`. Cards anchored beyond the end of
   * `messages` (defensive — should not happen in normal flow) render last.
   */
  cards?: Card[];
  /**
   * Label appended to thinking headers (e.g. "high" or "16384t"). Mirrors the
   * value the observer passed through previously; lifted into props so the
   * component stays a pure projection of state.
   */
  thinkingLabel?: string;
}

export function Messages({
  messages,
  cards,
  thinkingLabel,
}: MessagesProps): React.ReactElement {
  const resultIndex = React.useMemo(() => buildResultIndex(messages), [messages]);
  const cardsByAnchor = React.useMemo(() => groupCardsByAnchor(cards ?? []), [cards]);

  const leading = cardsByAnchor.get(-1) ?? [];
  const trailing: Card[] = [];
  if (cards) {
    for (const c of cards) {
      if (c.anchor >= messages.length) trailing.push(c);
    }
  }

  return (
    <Box flexDirection="column">
      {leading.map((c) => (
        <CardView key={`c${c.id}`} card={c} />
      ))}
      {messages.map((msg, i) => (
        <React.Fragment key={i}>
          <MessageView
            msg={msg}
            resultIndex={resultIndex}
            {...(thinkingLabel !== undefined ? { thinkingLabel } : {})}
          />
          {(cardsByAnchor.get(i) ?? []).map((c) => (
            <CardView key={`c${c.id}`} card={c} />
          ))}
        </React.Fragment>
      ))}
      {trailing.map((c) => (
        <CardView key={`c${c.id}`} card={c} />
      ))}
    </Box>
  );
}

function groupCardsByAnchor(cards: Card[]): Map<number, Card[]> {
  const m = new Map<number, Card[]>();
  for (const c of cards) {
    const arr = m.get(c.anchor);
    if (arr) arr.push(c);
    else m.set(c.anchor, [c]);
  }
  return m;
}

function CardView({ card }: { card: Card }): React.ReactElement {
  const color = card.kind === "error" ? red : card.kind === "warn" ? orange : blue;
  const bar = color("│");
  const bodyLines = card.text.split("\n");
  // Strip a single leading/trailing blank line — callers may pad with "\n"
  // out of habit from the static-print world, which would render as an empty
  // bar row here.
  while (bodyLines.length > 0 && bodyLines[0]?.trim() === "") bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]?.trim() === "") bodyLines.pop();
  if (bodyLines.length === 0 && !card.title) return <></>;
  return (
    <Box flexDirection="column" marginTop={1}>
      {card.title ? (
        <Box flexDirection="row">
          <Text>{bar} </Text>
          <Text bold>{color(card.title)}</Text>
        </Box>
      ) : null}
      {bodyLines.map((line, i) => (
        <Box key={i} flexDirection="row">
          <Text>{bar} </Text>
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

interface MessageViewProps {
  msg: MessageParam;
  resultIndex: Map<string, ToolResultBlock>;
  thinkingLabel?: string;
}

function MessageView({
  msg,
  resultIndex,
  thinkingLabel,
}: MessageViewProps): React.ReactElement | null {
  if (msg.role === "user") return <UserMessageView msg={msg} />;
  return (
    <AssistantMessageView
      msg={msg}
      resultIndex={resultIndex}
      {...(thinkingLabel !== undefined ? { thinkingLabel } : {})}
    />
  );
}

function UserMessageView({ msg }: { msg: MessageParam }): React.ReactElement | null {
  if (typeof msg.content === "string") {
    if (isSystemInjectionText(msg.content)) return null;
    return <UserBubble text={msg.content} />;
  }
  // user content blocks: tool_results render via their paired tool_use (skipped here),
  // text blocks (interject nudges, etc.) render with the prompt prefix.
  // System-injected text (reminders, long-running-command notifications) is
  // filtered out — those are not real user input.
  const textBlocks: string[] = [];
  for (const b of msg.content) {
    if (b.type !== "text") continue;
    if (b.text.trim().length === 0) continue;
    if (isSystemInjectionText(b.text)) continue;
    textBlocks.push(b.text);
  }
  if (textBlocks.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {textBlocks.map((t, i) => (
        <UserBubble key={i} text={t} />
      ))}
    </Box>
  );
}

function UserBubble({ text }: { text: string }): React.ReactElement {
  const { stdout } = useStdout();
  const width = Math.max(20, stdout?.columns ?? 80);
  // Render each visual line as a full-width banded row with the `›` prefix on
  // the first line. Padding to width gives a solid bar instead of a fragment
  // that hugs the text.
  const lines = text.split("\n");
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => {
        const prefix = i === 0 ? "› " : "  ";
        const content = ` ${prefix}${line}`;
        const pad = " ".repeat(Math.max(0, width - visibleWidth(content)));
        return (
          <Text key={i} backgroundColor={USER_BUBBLE_BG}>
            {content}
            {pad}
          </Text>
        );
      })}
    </Box>
  );
}

function AssistantMessageView({
  msg,
  resultIndex,
  thinkingLabel,
}: {
  msg: MessageParam;
  resultIndex: Map<string, ToolResultBlock>;
  thinkingLabel?: string;
}): React.ReactElement | null {
  const blocks = blocksOf(msg);
  const items: React.ReactNode[] = [];
  let key = 0;

  for (const block of blocks) {
    if (block.type === "thinking") {
      items.push(
        <ThinkingBlock
          key={key++}
          thinking={block.thinking}
          {...(thinkingLabel !== undefined ? { label: thinkingLabel } : {})}
        />,
      );
    } else if (block.type === "redacted_thinking") {
      items.push(
        <RedactedThinkingBlock
          key={key++}
          {...(thinkingLabel !== undefined ? { label: thinkingLabel } : {})}
        />,
      );
    } else if (block.type === "tool_use") {
      if (isHiddenTool(block.name)) continue;
      items.push(
        <ToolCall key={key++} use={block} result={resultIndex.get(block.id)} />,
      );
    }
  }

  // Collapse all text blocks into a single markdown render so headings, lists,
  // and tables across split blocks stay laid out as one document.
  const text = extractText(blocks);
  if (text.trim().length > 0) {
    items.push(
      <Box key={key++} marginTop={1}>
        <Text>{renderMarkdown(text)}</Text>
      </Box>,
    );
  }

  if (items.length === 0) return null;
  return <Box flexDirection="column">{items}</Box>;
}

// Re-export for callers that want to walk content blocks themselves.
export type { ContentBlock };
