import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type {
  AskUserAnswer,
  AskUserQuestionSpec,
  AskUserRequest,
  AskUserResponse,
} from "@nova/core";
import { ACCENT_HEX, CHIP_ACTIVE_BG_HEX } from "../colors.js";
import { t } from "../i18n/index.js";
import { countWrappedLines } from "./measure.js";
import { visibleWidth } from "./width.js";

interface QState {
  spec: AskUserQuestionSpec;
  options: Array<{ label: string; description?: string }>;
  selected: Set<number>;
  freeform: string;
}

type Phase = "options" | "freeform";

// Row indices of the Confirm tab's two buttons.
const CONFIRM_SUBMIT = 0;
const CONFIRM_CANCEL = 1;

/**
 * Gutter in front of an option's description, aligning it under the label:
 * `❯ ` (cursor) + `N. ` (number) = 5 columns. Double-digit lists would drift by
 * one, which is fine — a question with 10+ options is already past the point
 * where the alignment carries meaning.
 */
const DESC_INDENT = "     ";

/**
 * One tab of the question strip. The leading/trailing spaces are the chip's
 * padding: the active tab paints them with a background colour, so they have to
 * be part of the text rather than Box padding (Ink only fills a `<Text>`'s own
 * cells).
 */
function tabChip(header: string, status: string): string {
  return ` ${status} ${header} `;
}

function buildState(req: AskUserRequest): QState[] {
  return req.questions.map((spec) => {
    const seen = new Set(spec.options.map((o) => o.label.toLowerCase()));
    const options = [...spec.options];
    // Append the freeform "Other" option unless the spec opts out (allowFreeform
    // === false) or it's already present.
    if (spec.allowFreeform !== false && !seen.has(t.ask.other.toLowerCase())) {
      options.push({ label: t.ask.other, description: t.ask.otherDesc });
    }
    return { spec, options, selected: new Set<number>(), freeform: "" };
  });
}

function isAnswered(q: QState): boolean {
  if (q.selected.size === 0) return false;
  const otherIdx = q.options.findIndex((o) => o.label === t.ask.other);
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

/** The answer as shown on the Confirm tab: picked labels, with "Other" replaced by its text. */
function answerLabels(q: QState): string[] {
  return [...q.selected]
    .sort((a, b) => a - b)
    .map((i) => {
      const opt = q.options[i];
      if (opt && opt.label === t.ask.other && q.freeform.trim().length > 0) {
        return q.freeform.trim();
      }
      return opt?.label ?? "";
    });
}

/** Right-pad a summary header so the answer column lines up across questions. */
function padHeader(header: string, width: number): string {
  return header + " ".repeat(Math.max(0, width - visibleWidth(header)));
}

function buildResponse(states: QState[]): AskUserResponse {
  const answers: AskUserAnswer[] = states.map((q) => {
    const selected = [...q.selected].sort((a, b) => a - b).map((i) => q.options[i]?.label ?? "");
    const otherIdx = q.options.findIndex((o) => o.label === t.ask.other);
    const hasOther = otherIdx >= 0 && q.selected.has(otherIdx);
    const ans: AskUserAnswer = { selected };
    if (hasOther && q.freeform.trim().length > 0) ans.freeform = q.freeform.trim();
    return ans;
  });
  return { answers };
}

/** Wrappable width inside the panel's round border + paddingX (mirrors `approvalInnerWidth`). */
export function askInnerWidth(cols: number): number {
  return Math.max(1, cols - 4);
}

/**
 * Exact render height of the AskPanel below, so the viewport reserves the right
 * number of rows and the message region never paints over it. The panel shows
 * one question at a time but the user can move between them freely, so we
 * reserve the tallest one. Mirrors `approvalRows`/`pickListRows`.
 *
 * Box chrome: round border (2 rows) + outer marginTop/marginBottom (2) + the
 * hint line that sits below the box (1) = 5 rows.
 */
export function askRows(req: AskUserRequest, cols: number): number {
  const inner = askInnerWidth(cols);
  const states = buildState(req); // options here include any auto-added "Other"

  // The tab strip is one logical line of chips — ` ● header  → Confirm ` — that
  // can wrap when a multi-question ask carries long headers.
  const tabRows =
    countWrappedLines(
      [...states.map((s) => tabChip(s.spec.header, "●")), tabChip(t.ask.confirm, "→")].join(" "),
      inner,
    ) + 1; // + the blank line under the strip

  let maxBody = 0;
  for (const s of states) {
    const questionRows = countWrappedLines(s.spec.question, inner);
    // Multi-select rows carry a `[x] ` checkbox, which both indents the label
    // and pushes the description gutter out by the same 4 columns.
    const box = s.spec.multiSelect ? "[x] " : "";
    let optionRows = 0;
    for (const [i, o] of s.options.entries()) {
      optionRows += countWrappedLines(`❯ ${i + 1}. ${box}${o.label}`, inner);
      if (o.description) {
        optionRows += countWrappedLines(`${DESC_INDENT}${box}${o.description}`, inner);
      }
    }
    const hasOther = s.options.some((o) => o.label === t.ask.other);
    const freeformRows = hasOther ? 2 : 0; // blank + input line, when active
    maxBody = Math.max(maxBody, tabRows + questionRows + 1 + optionRows + freeformRows);
  }

  // Confirm tab: prompt + blank + one summary row per question + blank + the
  // two buttons. Worst-case answer value: every label joined (multiSelect) or
  // the longest single one. Freeform text is unbounded and not modeled.
  let summaryRows = 0;
  for (const s of states) {
    const value = s.spec.multiSelect
      ? s.spec.options.map((o) => o.label).join(", ")
      : s.spec.options.reduce((a, o) => (o.label.length > a.length ? o.label : a), "");
    summaryRows += countWrappedLines(`    ${s.spec.header}  ${value}`, inner);
  }
  const buttonRows =
    countWrappedLines(`❯ 1. ${t.ask.submit}${t.ask.answerAllFirst}`, inner) +
    countWrappedLines(`  2. ${t.ask.cancel}`, inner);
  maxBody = Math.max(
    maxBody,
    tabRows + countWrappedLines(t.ask.reviewSubmit, inner) + 1 + summaryRows + 1 + buttonRows,
  );

  return 5 + maxBody;
}

export interface AskPanelProps {
  req: AskUserRequest;
  onResolve: (value: AskUserResponse) => void;
  /** Viewport inner width, threaded like the approval modal's so wrapping agrees. */
  panelWidth?: number;
}

export function AskPanel({ req, onResolve, panelWidth }: AskPanelProps): React.ReactElement | null {
  const [states, setStates] = useState<QState[]>(() => buildState(req));
  const [tab, setTab] = useState(0);
  const [optIndex, setOptIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("options");
  const [freeformBuffer, setFreeformBuffer] = useState("");
  const [confirmIndex, setConfirmIndex] = useState(CONFIRM_SUBMIT);
  const { stdout } = useStdout();
  const cols = panelWidth ?? stdout?.columns ?? 80;

  const total = states.length;
  const confirmTab = total; // the Confirm tab always sits one past the last question
  const tabCount = total + 1;
  const isConfirm = tab === confirmTab;
  const q = states[tab];
  if (!isConfirm && !q) return null;
  const otherIdx = q ? q.options.findIndex((o) => o.label === t.ask.other) : -1;
  const everyAnswered = states.every(isAnswered);
  const headerWidth = Math.max(...states.map((s) => visibleWidth(s.spec.header)));

  const cancel = (): void => onResolve({ answers: [], cancelled: true });

  /** Move to question `idx`, parking the cursor on whatever it already answered. */
  const goToQuestion = (next: QState[], idx: number): void => {
    setTab(idx);
    const target = next[idx];
    const first = target ? [...target.selected].sort((a, b) => a - b)[0] : undefined;
    setOptIndex(first ?? 0);
    setPhase("options");
  };

  const updateCurrent = (mut: (q: QState) => QState): void => {
    setStates((prev) => {
      const next = cloneStates(prev);
      const cur = next[tab];
      if (cur) next[tab] = mut(cur);
      return next;
    });
  };

  /**
   * After answering, move to the next still-unanswered question; once every
   * question has an answer, land on the Confirm tab rather than submitting —
   * the response only goes out when the user activates Submit there.
   */
  const advanceOrConfirm = (next: QState[]): void => {
    for (let step = 1; step <= next.length; step++) {
      const idx = (tab + step) % next.length;
      const nq = next[idx];
      if (nq && !isAnswered(nq)) {
        goToQuestion(next, idx);
        return;
      }
    }
    setTab(confirmTab);
    setConfirmIndex(CONFIRM_SUBMIT);
    setPhase("options");
  };

  /** Submit, unless a question is still open — then jump to it instead. */
  const submit = (next: QState[]): void => {
    if (next.every(isAnswered)) {
      onResolve(buildResponse(next));
      return;
    }
    const idx = next.findIndex((nq) => !isAnswered(nq));
    if (idx >= 0) goToQuestion(next, idx);
  };

  const commitFreeform = (): void => {
    setStates((prev) => {
      const next = cloneStates(prev);
      const cur = next[tab];
      if (!cur) return prev;
      const oIdx = cur.options.findIndex((o) => o.label === t.ask.other);
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
        setTimeout(() => advanceOrConfirm(next), 0);
      }
      return next;
    });
  };

  /** Choose option `idx`: single-select commits and moves on, multi toggles. */
  const choose = (idx: number): void => {
    if (!q) return;
    if (idx === otherIdx) {
      setOptIndex(idx);
      setFreeformBuffer(q.freeform);
      setPhase("freeform");
      return;
    }
    setOptIndex(idx);
    if (q.spec.multiSelect) {
      updateCurrent((cur) => {
        const sel = new Set(cur.selected);
        if (sel.has(idx)) sel.delete(idx);
        else sel.add(idx);
        return { ...cur, selected: sel };
      });
      return;
    }
    setStates((prev) => {
      const next = cloneStates(prev);
      const cur = next[tab];
      if (!cur) return prev;
      cur.selected = new Set([idx]);
      setTimeout(() => advanceOrConfirm(next), 0);
      return next;
    });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      cancel();
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

    if (key.escape) {
      cancel();
      return;
    }

    // Paging between tabs (questions + Confirm) stays available so answers can
    // be revised; it just isn't the primary flow — answering advances for you.
    const goToTab = (idx: number): void => {
      if (idx === confirmTab) {
        setTab(confirmTab);
        setConfirmIndex(CONFIRM_SUBMIT);
        setPhase("options");
        return;
      }
      goToQuestion(states, idx);
    };
    if (key.leftArrow || (key.shift && key.tab)) {
      goToTab((tab - 1 + tabCount) % tabCount);
      return;
    }
    if (key.rightArrow || (key.tab && !key.shift)) {
      goToTab((tab + 1) % tabCount);
      return;
    }

    if (isConfirm) {
      const activate = (idx: number): void => {
        if (idx === CONFIRM_CANCEL) cancel();
        else submit(states);
      };
      if (key.upArrow || key.downArrow) {
        setConfirmIndex((i) => (i === CONFIRM_SUBMIT ? CONFIRM_CANCEL : CONFIRM_SUBMIT));
        return;
      }
      if (input === "1" || input === "2") {
        const idx = Number(input) - 1;
        setConfirmIndex(idx);
        activate(idx);
        return;
      }
      if (key.return) activate(confirmIndex);
      return;
    }

    if (!q) return;
    if (key.upArrow) {
      setOptIndex((i) => (i - 1 + q.options.length) % q.options.length);
      return;
    }
    if (key.downArrow) {
      setOptIndex((i) => (i + 1) % q.options.length);
      return;
    }
    // Number keys pick an option directly, matching the `N.` prefix on each row.
    if (input.length === 1 && input >= "1" && input <= "9") {
      const idx = Number(input) - 1;
      if (idx < q.options.length) choose(idx);
      return;
    }
    if (input === " " && q.spec.multiSelect) {
      choose(optIndex);
      return;
    }
    if (key.return) {
      // Multi-select confirms the toggled set (falling back to the row under
      // the cursor when nothing is ticked yet); single-select picks the row.
      if (q.spec.multiSelect && q.selected.size > 0) {
        advanceOrConfirm(states);
        return;
      }
      choose(optIndex);
      return;
    }
  });

  const hints = isConfirm
    ? [t.ask.navButton, t.ask.navPick(2), t.ask.navQuestion, t.ask.navActivate, t.ask.navCancel]
    : [
        t.ask.navOption,
        t.ask.navPick(q?.options.length ?? 0),
        q?.spec.multiSelect ? t.ask.navToggle : "",
        t.ask.navQuestion,
        t.ask.navNext,
        t.ask.navCancel,
      ];

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} width={cols}>
      <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="gray">
        <Box>
          {[
            ...states.map((s, i) => ({
              key: s.spec.header,
              label: s.spec.header,
              status: isAnswered(s) ? "✓" : i === tab ? "●" : "○",
              isCur: i === tab,
            })),
            {
              key: "__confirm",
              label: t.ask.confirm,
              status: everyAnswered ? "✓" : "→",
              isCur: isConfirm,
            },
          ].map((chip, i) => (
            <React.Fragment key={chip.key}>
              {i > 0 ? <Text> </Text> : null}
              <Text
                bold={chip.isCur}
                color={chip.isCur ? "white" : undefined}
                dimColor={!chip.isCur}
                {...(chip.isCur ? { backgroundColor: CHIP_ACTIVE_BG_HEX } : {})}
              >
                {tabChip(chip.label, chip.status)}
              </Text>
            </React.Fragment>
          ))}
        </Box>
        <Text> </Text>
        <Text>{isConfirm ? t.ask.reviewSubmit : q?.spec.question}</Text>
        <Text> </Text>
        {isConfirm ? (
          <>
            {states.map((s, i) => {
              const labels = answerLabels(s);
              return (
                <Text key={i}>
                  {"    "}
                  <Text dimColor>{padHeader(s.spec.header, headerWidth)}</Text>
                  {"  "}
                  <Text color={labels.length > 0 ? undefined : "yellow"}>
                    {labels.length > 0 ? labels.join(", ") : t.ask.noAnswer}
                  </Text>
                </Text>
              );
            })}
            <Text> </Text>
            {[
              { idx: CONFIRM_SUBMIT, label: t.ask.submit, color: "green" as const },
              { idx: CONFIRM_CANCEL, label: t.ask.cancel, color: "red" as const },
            ].map((b) => {
              const isCur = confirmIndex === b.idx;
              const disabled = b.idx === CONFIRM_SUBMIT && !everyAnswered;
              return (
                <Text key={b.idx} color={isCur ? ACCENT_HEX : undefined}>
                  {isCur ? "❯ " : "  "}
                  <Text dimColor={!isCur}>{b.idx + 1}.</Text>{" "}
                  <Text color={isCur ? b.color : undefined} dimColor={disabled && !isCur}>
                    {b.label}
                  </Text>
                  {disabled ? <Text dimColor>{t.ask.answerAllFirst}</Text> : null}
                </Text>
              );
            })}
          </>
        ) : (
          q?.options.map((o, i) => {
          const isCur = i === optIndex;
          const isSelected = q.selected.has(i);
          const label =
            i === otherIdx && q.freeform.trim().length > 0 ? `${o.label}: ${q.freeform}` : o.label;
          return (
            <React.Fragment key={i}>
              <Text color={isCur ? ACCENT_HEX : undefined}>
                {isCur ? "❯ " : "  "}
                <Text dimColor={!isCur}>{i + 1}.</Text>{" "}
                {q.spec.multiSelect ? `${isSelected ? "[x]" : "[ ]"} ` : ""}
                {label}
              </Text>
              {o.description ? (
                <Text dimColor>
                  {DESC_INDENT}
                  {q.spec.multiSelect ? "    " : ""}
                  {o.description}
                </Text>
                ) : null}
              </React.Fragment>
            );
          })
        )}
        {phase === "freeform" ? (
          <>
            <Text> </Text>
            <Box>
              <Text color={ACCENT_HEX}>{"  › "}</Text>
              <Text>{freeformBuffer}</Text>
              <Text inverse> </Text>
              {freeformBuffer.length === 0 ? (
                <Text dimColor>
                  {"  "}
                  {t.ask.freeformHint}
                </Text>
              ) : null}
            </Box>
          </>
        ) : null}
      </Box>
      <Text dimColor>
        {"  "}
        {(phase === "freeform" ? [t.ask.navFreeform] : hints).filter((x) => x.length > 0).join(" · ")}
      </Text>
    </Box>
  );
}
