import React, { useState } from "react";
import { Box, render, Text, useInput } from "ink";
import type { PermissionDecision, PermissionInput } from "./permission.js";

type Answer = "yes" | "no" | "always-allow";

interface Option {
  value: Answer;
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

interface Props {
  decision: PermissionDecision;
  input: PermissionInput;
  onAnswer: (answer: Answer) => void;
  onCancel?: () => void;
}

const ApprovalPrompt: React.FC<Props> = ({ decision, input, onAnswer, onCancel }) => {
  const [cursor, setCursor] = useState(0);

  const submit = (answer: Answer) => {
    onAnswer(answer);
  };

  useInput((char, key) => {
    if (key.escape) {
      onCancel?.();
      submit("no");
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
      if (chosen) submit(chosen.value);
      return;
    }
    const k = char?.toLowerCase();
    const match = OPTIONS.find((o) => o.shortcut === k);
    if (match) submit(match.value);
  });

  const inputPreview = JSON.stringify(input.input, null, 2);
  const truncated =
    inputPreview.length > 600 ? `${inputPreview.slice(0, 600)}\n…(truncated)` : inputPreview;

  return (
    <Box flexDirection="column" padding={0} marginY={1}>
      <Text bold color="#FFA500">
        Permission required
      </Text>
      {/* <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text bold>tool:</Text> {input.tool}
        </Text>
        <Text>
          <Text bold>reason:</Text> {decision.reason}
        </Text>
        <Text bold>input:</Text>
        <Text dimColor>{truncated}</Text>
      </Box> */}
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
};

async function promptApprovalReadline(
  decision: PermissionDecision,
  input: PermissionInput,
): Promise<Answer> {
  const { createInterface } = await import("node:readline");
  const inputPreview = JSON.stringify(input.input, null, 2);
  const truncated =
    inputPreview.length > 600 ? `${inputPreview.slice(0, 600)}\n…(truncated)` : inputPreview;

  process.stderr.write(
    [
      "",
      "🛂  Permission required",
      `  tool:   ${input.tool}`,
      `  reason: ${decision.reason}`,
      "  input:",
      truncated.split("\n").map((l) => `    ${l}`).join("\n"),
      "",
      "  1) Allow once (y)",
      "  2) Deny (n)",
      "  3) Always allow this tool (a)",
      "",
    ].join("\n"),
  );

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const ans = (await new Promise<string>((r) => rl.question("> ", r))).trim().toLowerCase();
      if (ans === "1" || ans === "y" || ans === "yes") return "yes";
      if (ans === "2" || ans === "n" || ans === "no" || ans === "") return "no";
      if (ans === "3" || ans === "a" || ans === "always") return "always-allow";
      process.stderr.write("  invalid choice, try 1/2/3 or y/n/a\n");
    }
  } finally {
    rl.close();
  }
}

export interface PromptApprovalOptions {
  signal?: AbortSignal;
  onCancel?: () => void;
}

export async function promptApproval(
  decision: PermissionDecision,
  input: PermissionInput,
  opts: PromptApprovalOptions = {},
): Promise<Answer> {
  if (opts.signal?.aborted) return "no";
  if (!process.stdin.isTTY) {
    return promptApprovalReadline(decision, input);
  }

  return new Promise<Answer>((resolve) => {
    let resolved = false;
    const finish = (answer: Answer) => {
      if (resolved) return;
      resolved = true;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = (): void => {
      // Programmatic abort: tear down Ink. The waitUntilExit handler below
      // resolves with "no" once unmount completes.
      try {
        instance.clear();
      } catch {
        // ignore
      }
      try {
        instance.unmount();
      } catch {
        // ignore
      }
    };
    const instance = render(
      <ApprovalPrompt
        decision={decision}
        input={input}
        {...(opts.onCancel ? { onCancel: opts.onCancel } : {})}
        onAnswer={(answer) => {
          instance.clear();
          instance.unmount();
          finish(answer);
        }}
      />,
    );
    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    instance.waitUntilExit().then(() => {
      finish("no");
    });
  });
}
