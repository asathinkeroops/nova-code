import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolUseBlock } from "@nova/core";
import type { PermissionDecision, PermissionInput } from "@nova/safety";
import { ToolUsePreview } from "./tool-call.js";

export type ApprovalAnswer = "yes" | "no" | "always-allow";

interface Option {
  value: ApprovalAnswer;
  label: string;
  hint: string;
  shortcut: string;
  color: "green" | "red" | "cyan";
}

const OPTIONS: Option[] = [
  { value: "yes", label: "Allow once", hint: "y", shortcut: "y", color: "green" },
  { value: "no", label: "Deny", hint: "n", shortcut: "n", color: "red" },
  {
    value: "always-allow",
    label: "Always allow this tool",
    hint: "a",
    shortcut: "a",
    color: "cyan",
  },
];

export interface ApprovalPromptProps {
  decision: PermissionDecision;
  input: PermissionInput;
  onAnswer: (answer: ApprovalAnswer) => void;
  onCancel?: () => void;
  /**
   * Scroll the surrounding viewport. Wired by the host so the user can scroll
   * up through a long pending edit/write diff while the prompt is open —
   * otherwise the slice clips the top of the diff and there's no way to see
   * what's actually being approved.
   */
  onScroll?: (delta: number) => void;
}

const SCROLL_PAGE_LINES = 10;

export function ApprovalPrompt({
  input,
  onAnswer,
  onCancel,
  onScroll,
}: ApprovalPromptProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);

  useInput((char, key) => {
    if (key.escape) {
      onCancel?.();
      onAnswer("no");
      return;
    }
    if (key.pageUp) {
      onScroll?.(-SCROLL_PAGE_LINES);
      return;
    }
    if (key.pageDown) {
      onScroll?.(SCROLL_PAGE_LINES);
      return;
    }
    if (key.upArrow || char === "k") {
      setCursor((c) => (c - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow || char === "j") {
      setCursor((c) => (c + 1) % OPTIONS.length);
      return;
    }
    if (key.return) {
      const chosen = OPTIONS[cursor];
      if (chosen) onAnswer(chosen.value);
      return;
    }
    const k = char?.toLowerCase();
    const match = OPTIONS.find((o) => o.shortcut === k);
    if (match) onAnswer(match.value);
  });

  // Synthesize a ToolUseBlock for the shared preview. The `id` is unused by
  // ToolUsePreview itself — it only matters in transcripts for pairing with
  // tool_results — but the type still requires a string.
  const use: ToolUseBlock = {
    type: "tool_use",
    id: "approval-preview",
    name: input.tool,
    input: input.input,
  };

  return (
    <Box flexDirection="column" padding={1} marginTop={1} marginBottom={1} borderStyle={"round"}>
      <ToolUsePreview use={use} headerOnly />

      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const active = i === cursor;
          return (
            <Text key={opt.value} color={active ? opt.color : undefined}>
              {active ? "❯ " : "  "}
              <Text bold={active}>{opt.label}</Text>
              <Text dimColor> ({opt.hint})</Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ option · pgup/pgdn scroll · enter confirm · y/n/a shortcut · esc cancel</Text>
      </Box>
    </Box>
  );
}
