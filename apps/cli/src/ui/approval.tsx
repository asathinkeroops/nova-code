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
}

export function ApprovalPrompt({
  decision,
  input,
  onAnswer,
  onCancel,
}: ApprovalPromptProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);

  useInput((char, key) => {
    if (key.escape) {
      onCancel?.();
      onAnswer("no");
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
      <Text bold color="#FFA500">
        Permission required
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <ToolUsePreview use={use} headerOnly />
        {decision.reason ? (
          <Box marginTop={1}>
            <Text dimColor>Reason: {decision.reason}</Text>
          </Box>
        ) : null}
      </Box>

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
        <Text dimColor>↑/↓ to navigate · enter to confirm · y/n/a shortcut · esc to cancel</Text>
      </Box>
    </Box>
  );
}
