import React from "react";
import { Box, Text, useStdout } from "ink";
import {
  blocksOf,
  extractText,
  type ContentBlock,
  type MessageParam,
  type ToolResultBlock,
} from "@nova/core";
import { renderMarkdown } from "./markdown.js";
import { RedactedThinkingBlock, ThinkingBlock } from "./thinking.js";
import { ToolCall } from "./tool-call.js";
import { visibleWidth } from "./width.js";

const USER_BUBBLE_BG = "#3a3a3a";

/**
 * Todo tools are bookkeeping for the agent; the user sees the result in the
 * footer, so we hide their tool_use / tool_result rows from the transcript.
 */
function isTodoTool(name: string): boolean {
  return name === "createTodo" || name === "updateTodo" || name === "getTodos";
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
   * Label appended to thinking headers (e.g. "high" or "16384t"). Mirrors the
   * value the observer passed through previously; lifted into props so the
   * component stays a pure projection of state.
   */
  thinkingLabel?: string;
}

export function Messages({
  messages,
  thinkingLabel,
}: MessagesProps): React.ReactElement {
  const resultIndex = React.useMemo(() => buildResultIndex(messages), [messages]);
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageView
          key={i}
          msg={msg}
          resultIndex={resultIndex}
          {...(thinkingLabel !== undefined ? { thinkingLabel } : {})}
        />
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
    return <UserBubble text={msg.content} />;
  }
  // user content blocks: tool_results render via their paired tool_use (skipped here),
  // text blocks (interject nudges, etc.) render with the prompt prefix.
  const textBlocks: string[] = [];
  for (const b of msg.content) {
    if (b.type === "text" && b.text.trim().length > 0) textBlocks.push(b.text);
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
      if (isTodoTool(block.name)) continue;
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
