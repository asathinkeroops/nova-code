import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionDecision, PermissionInput } from "@nova/safety";

export type ApprovalAnswer = "yes" | "no" | "always-allow";

const TOOL_PROMPTS: Record<string, string> = {
  read: "Allow reading this file?",
  write: "Allow writing this file?",
  edit: "Allow editing this file?",
  bash: "Allow running this command?",
  glob: "Allow searching for files?",
  grep: "Allow searching file contents?",
  webfetch: "Allow fetching this URL?",
  websearch: "Allow searching the web?",
  createSubAgent: "Allow spawning a subagent?",
  runLongRunningCommand: "Allow running this command in the background?",
};

function promptFor(tool: string): string {
  return TOOL_PROMPTS[tool] ?? "Allow this operation?";
}

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

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text>{promptFor(input.tool)}</Text>

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
    </Box>
  );
}
