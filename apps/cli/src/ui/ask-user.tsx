import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
  AskUserAnswer,
  AskUserQuestionSpec,
  AskUserRequest,
  AskUserResponse,
} from "@nova/core";
import { visibleWidth } from "./width.js";

const OTHER_LABEL = "Other";

interface QState {
  spec: AskUserQuestionSpec;
  options: Array<{ label: string; description?: string }>;
  selected: Set<number>;
  freeform: string;
}

type Phase = "options" | "freeform";

function buildState(req: AskUserRequest): QState[] {
  return req.questions.map((spec) => {
    const seen = new Set(spec.options.map((o) => o.label.toLowerCase()));
    const options = [...spec.options];
    if (!seen.has(OTHER_LABEL.toLowerCase())) {
      options.push({ label: OTHER_LABEL, description: "type a custom answer" });
    }
    return { spec, options, selected: new Set<number>(), freeform: "" };
  });
}

function isAnswered(q: QState): boolean {
  if (q.selected.size === 0) return false;
  const otherIdx = q.options.findIndex((o) => o.label === OTHER_LABEL);
  if (otherIdx >= 0 && q.selected.has(otherIdx) && q.freeform.trim().length === 0) {
    return false;
  }
  return true;
}

function cloneStates(states: QState[]): QState[] {
  return states.map((q) => ({
    ...q,
    selected: new Set(q.selected),
  }));
}

function buildResponse(states: QState[]): AskUserResponse {
  const answers: AskUserAnswer[] = states.map((q) => {
    const selected = [...q.selected].sort((a, b) => a - b).map((i) => q.options[i]?.label ?? "");
    const otherIdx = q.options.findIndex((o) => o.label === OTHER_LABEL);
    const hasOther = otherIdx >= 0 && q.selected.has(otherIdx);
    const ans: AskUserAnswer = { selected };
    if (hasOther && q.freeform.trim().length > 0) ans.freeform = q.freeform.trim();
    return ans;
  });
  return { answers };
}

export interface AskPanelProps {
  req: AskUserRequest;
  onResolve: (value: AskUserResponse) => void;
}

export function AskPanel({ req, onResolve }: AskPanelProps): React.ReactElement | null {
  const [states, setStates] = useState<QState[]>(() => buildState(req));
  const [tab, setTab] = useState(0);
  const [optIndex, setOptIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("options");
  const [freeformBuffer, setFreeformBuffer] = useState("");

  const q = states[tab];
  if (!q) return null;
  const otherIdx = q.options.findIndex((o) => o.label === OTHER_LABEL);
  const total = states.length;

  const updateCurrent = (mut: (q: QState) => QState): void => {
    setStates((prev) => {
      const next = cloneStates(prev);
      const cur = next[tab];
      if (cur) next[tab] = mut(cur);
      return next;
    });
  };

  const allAnswered = (next: QState[]): boolean => next.every(isAnswered);

  const advanceOrSubmit = (next: QState[]): void => {
    if (allAnswered(next)) {
      onResolve(buildResponse(next));
      return;
    }
    for (let step = 1; step <= next.length; step++) {
      const idx = (tab + step) % next.length;
      const nq = next[idx];
      if (nq && !isAnswered(nq)) {
        setTab(idx);
        setOptIndex(0);
        setPhase("options");
        return;
      }
    }
    onResolve(buildResponse(next));
  };

  const commitFreeform = (): void => {
    setStates((prev) => {
      const next = cloneStates(prev);
      const cur = next[tab];
      if (!cur) return prev;
      const oIdx = cur.options.findIndex((o) => o.label === OTHER_LABEL);
      if (oIdx < 0) {
        setPhase("options");
        return next;
      }
      const text = freeformBuffer.trim();
      if (text.length === 0) {
        cur.selected.delete(oIdx);
        cur.freeform = "";
        setFreeformBuffer("");
        setPhase("options");
        return next;
      }
      cur.freeform = text;
      cur.selected.add(oIdx);
      if (!cur.spec.multiSelect) {
        cur.selected = new Set([oIdx]);
      }
      setFreeformBuffer("");
      setPhase("options");
      if (!cur.spec.multiSelect) {
        setTimeout(() => advanceOrSubmit(next), 0);
      }
      return next;
    });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onResolve({ answers: [], cancelled: true });
      return;
    }

    if (phase === "freeform") {
      if (key.escape) {
        setFreeformBuffer("");
        setPhase("options");
        return;
      }
      if (key.return) {
        commitFreeform();
        return;
      }
      // Ink 5 maps macOS Backspace (\x7f) to key.delete; treat both as backward delete.
      if (key.backspace || key.delete) {
        setFreeformBuffer((s) => s.slice(0, -1));
        return;
      }
      if (!input) return;
      // eslint-disable-next-line no-control-regex
      const text = input.replace(/[\x00-\x1f]/g, "");
      if (text.length === 0) return;
      setFreeformBuffer((s) => s + text);
      return;
    }

    if ((key.leftArrow || (key.shift && key.tab)) && total > 1) {
      setTab((t) => (t - 1 + total) % total);
      setOptIndex(0);
      return;
    }
    if ((key.rightArrow || (key.tab && !key.shift)) && total > 1) {
      setTab((t) => (t + 1) % total);
      setOptIndex(0);
      return;
    }
    if (key.upArrow) {
      setOptIndex((i) => (i - 1 + q.options.length) % q.options.length);
      return;
    }
    if (key.downArrow) {
      setOptIndex((i) => (i + 1) % q.options.length);
      return;
    }
    if (input === " " && q.spec.multiSelect) {
      if (optIndex === otherIdx) {
        setFreeformBuffer(q.freeform);
        setPhase("freeform");
        return;
      }
      updateCurrent((cur) => {
        const sel = new Set(cur.selected);
        if (sel.has(optIndex)) sel.delete(optIndex);
        else sel.add(optIndex);
        return { ...cur, selected: sel };
      });
      return;
    }
    if (key.return) {
      if (optIndex === otherIdx) {
        setFreeformBuffer(q.freeform);
        setPhase("freeform");
        return;
      }
      if (q.spec.multiSelect) {
        setStates((prev) => {
          const next = cloneStates(prev);
          const cur = next[tab];
          if (!cur) return prev;
          if (cur.selected.size === 0) {
            cur.selected.add(optIndex);
          }
          if (isAnswered(cur)) {
            setTimeout(() => advanceOrSubmit(next), 0);
          }
          return next;
        });
        return;
      }
      setStates((prev) => {
        const next = cloneStates(prev);
        const cur = next[tab];
        if (!cur) return prev;
        cur.selected = new Set([optIndex]);
        setTimeout(() => advanceOrSubmit(next), 0);
        return next;
      });
      return;
    }
  });

  const labelWidth = Math.max(...q.options.map((o) => visibleWidth(o.label)));

  return (
    <Box flexDirection="column" padding={1} marginTop={1} marginBottom={1} borderStyle={'round'}>
      <Text>
        <Text bold color="cyan">
          ?
        </Text>{" "}
        {q.spec.question}
      </Text>
      {total > 1 ? (
        <Box>
          {states.map((s, i) => {
            const status = isAnswered(s) ? "✓" : i === tab ? "●" : "○";
            const text = ` ${status} ${s.spec.header} `;
            return (
              <Text key={i} color={i === tab ? "cyan" : undefined} dimColor={i !== tab}>
                {i > 0 ? " " : ""}
                [{text}]
              </Text>
            );
          })}
        </Box>
      ) : null}
      <Text> </Text>
      {q.options.map((o, i) => {
        const isCur = i === optIndex;
        const isSelected = q.selected.has(i);
        const marker = q.spec.multiSelect ? (isSelected ? "[x]" : "[ ]") : isSelected ? "●" : "○";
        const cur = isCur ? "❯" : " ";
        const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(o.label)));
        return (
          <Text key={i}>
            {"  "}
            <Text color={isCur ? "cyan" : undefined}>{cur}</Text>
            {" "}
            {marker}
            {" "}
            <Text color={isCur ? "cyan" : undefined}>{o.label}</Text>
            {pad}
            {o.description ? (
              <>
                {"  "}
                <Text dimColor>{o.description}</Text>
              </>
            ) : null}
          </Text>
        );
      })}
      {phase === "freeform" ? (
        <>
          <Text> </Text>
          <Box>
            <Text color="cyan">{"  › "}</Text>
            <Text>{freeformBuffer}</Text>
            <Text inverse> </Text>
            {freeformBuffer.length === 0 ? (
              <Text dimColor>
                {"  "}type your custom answer, Enter to confirm, Esc to cancel
              </Text>
            ) : null}
          </Box>
        </>
      ) : null}
      <Text> </Text>
      <Text dimColor>
        {[
          total > 1 ? "←/→ tab" : "",
          "↑/↓ option",
          q.spec.multiSelect ? "space toggle" : "",
          phase === "freeform" ? "enter confirm · esc cancel" : "enter next/submit",
          "ctrl+c cancel",
        ]
          .filter((x) => x.length > 0)
          .join(" · ")}
      </Text>
    </Box>
  );
}
