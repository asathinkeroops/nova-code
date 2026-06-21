import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { PermissionDecision, PermissionInput } from "@nova/safety";
import { ACCENT_HEX, cyan } from "../colors.js";
import { countWrappedLines } from "./measure.js";
import { PENDING_DOT, renderCommandBody } from "./render-strings.js";

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
  runInBackground: "Allow running this command in the background?",
};

function promptFor(tool: string): string {
  return TOOL_PROMPTS[tool] ?? "Allow this operation?";
}

// bash is rendered to mirror its message-stream display (render-strings.ts): a
// `● bash` header with the command shown as `⎿`-gutter body rows, so the prompt
// previews the command exactly as the transcript will print it. Other tools
// keep the one-line `tool detail` summary.
const BASH_HEADER = `${PENDING_DOT} ${cyan("bash")}`;
// Indent that aligns continuation/notice rows under the `⎿` body gutter
// (matches THINKING_INDENT in render-strings.ts).
const BASH_BODY_INDENT = "     ";

// Salient input fields, in priority order, used to summarize a tool call in the
// prompt. The first present string wins; otherwise we fall back to pretty JSON.
const DETAIL_KEYS = ["command", "path", "url", "pattern", "query", "description"];
const MAX_DETAIL_LINES = 16;
const MAX_DETAIL_CHARS = 1200;

/**
 * Human-readable summary of a tool call's input, shown in the approval modal so
 * the user always sees WHAT is being approved. This matters for subagent / goal
 * evaluator calls, whose tool_use blocks never appear in the main message feed
 * (the main agent's do, but showing it here too is harmless).
 */
export function describeToolInput(input: PermissionInput["input"]): string {
  for (const key of DETAIL_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Clamp the detail to a bounded height so a huge input can't blow up the modal. */
export function clampDetail(s: string): { text: string; truncated: boolean } {
  let truncated = false;
  let lines = s.split("\n");
  if (lines.length > MAX_DETAIL_LINES) {
    lines = lines.slice(0, MAX_DETAIL_LINES);
    truncated = true;
  }
  let text = lines.join("\n");
  if (text.length > MAX_DETAIL_CHARS) {
    text = text.slice(0, MAX_DETAIL_CHARS);
    truncated = true;
  }
  return { text, truncated };
}

interface Option {
  value: ApprovalAnswer;
  label: string;
  hint: string;
  shortcut: string;
  /** Ink color for the option (keyword or hex). */
  color: string;
}

const OPTIONS: Option[] = [
  { value: "yes", label: "Allow once", hint: "y", shortcut: "y", color: "green" },
  { value: "no", label: "Deny", hint: "n", shortcut: "n", color: "red" },
  {
    value: "always-allow",
    label: "Always allow this tool",
    hint: "a",
    shortcut: "a",
    color: ACCENT_HEX,
  },
];

/**
 * Exact rendered row count of {@link ApprovalPrompt} at a given terminal width,
 * so the viewport can reserve the right number of chrome rows. Mirrors the JSX
 * below — keep the two in sync, or the message text region under-reserves and
 * paints over the modal (the bug a hardcoded constant caused: it ignored the
 * border, the wrapped detail line, and the options' marginTop).
 *
 * Round border eats 2 columns and paddingX={1} another 2, so wrapping is
 * measured against `cols - 4`. Vertical rows:
 *   border top + bottom            = 2
 *   outer marginTop + marginBottom = 2
 *   prompt (wraps)                 = countWrappedLines(prompt)
 *   blank gap line                 = 1
 *   detail "tool + input" (wraps,  = countWrappedLines(detail)
 *     up to MAX_DETAIL_LINES tall)   — non-bash tools
 *   bash instead shows a `● bash`  = 1 + renderCommandBody rows (+1 if
 *     header + `⎿`-gutter command       truncated), mirroring the message feed
 *   options box marginTop          = 1
 *   one row per option             = OPTIONS.length
 */
export function approvalRows(input: PermissionInput, cols: number): number {
  const inner = Math.max(1, cols - 4);
  const { text: detail, truncated } = clampDetail(describeToolInput(input.input));
  const base =
    2 + // border top + bottom
    2 + // outer marginTop + marginBottom
    countWrappedLines(promptFor(input.tool), inner) +
    1 + // blank gap line
    1 + // options box marginTop
    OPTIONS.length;
  if (input.tool === "bash") {
    // `● bash` header row + the command rendered as `⎿`-gutter body rows
    // (renderCommandBody already wraps to `inner`, so each line is one row) +
    // an optional truncation notice on its own row.
    return (
      base +
      1 + // `● bash` header
      renderCommandBody(detail, inner).split("\n").length +
      (truncated ? 1 : 0)
    );
  }
  const detailLine = `${input.tool} ${detail}${truncated ? " … (truncated)" : ""}`;
  return base + countWrappedLines(detailLine, inner);
}

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

  const { stdout } = useStdout();
  const inner = Math.max(1, (stdout?.columns ?? 80) - 4);
  const { text: detail, truncated } = clampDetail(describeToolInput(input.input));

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      paddingX={1}
      borderStyle="round"
      borderColor="gray"
    >
      <Text>{promptFor(input.tool)}</Text>
      <Text>{' '}</Text>
      {input.tool === "bash" ? (
        // Mirror the message-stream bash rendering: `● bash` header with the
        // command under a `⎿` gutter, so heredocs/long one-liners preview the
        // way they'll print in the transcript instead of as a flat line.
        <>
          <Text>{BASH_HEADER}</Text>
          <Text>{renderCommandBody(detail, inner)}</Text>
          {truncated ? (
            <Text dimColor>{`${BASH_BODY_INDENT}… (truncated)`}</Text>
          ) : null}
        </>
      ) : (
        <Text>
          <Text dimColor>{input.tool} </Text>
          <Text color={ACCENT_HEX}>{detail}</Text>
          {truncated ? <Text dimColor> … (truncated)</Text> : null}
        </Text>
      )}

      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const active = i === cursor;
          return (
            <Text key={opt.value} color={active ? opt.color : undefined}>
              {active ? "❯ " : "  "}
              <Text>{opt.label}</Text>
              <Text dimColor> ({opt.hint})</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
