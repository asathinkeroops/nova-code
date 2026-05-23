import type {
  AskUserAnswer,
  AskUserQuestionSpec,
  AskUserRequest,
  AskUserResponse,
} from "@nova/core";
import { bold, cyan, dim, useColor } from "./colors.js";

const ESC = "\x1b";
const CSI = `${ESC}[`;

const cursorUp = (n: number): string => (n > 0 ? `${CSI}${n}A` : "");
const cursorToCol = (col: number): string => `${CSI}${col}G`;
const clearBelow = `${CSI}0J`;

const OTHER_LABEL = "Other";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

function visibleWidth(s: string): number {
  const t = stripAnsi(s);
  let w = 0;
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    w += isWide(code) ? 2 : 1;
  }
  return w;
}

interface QuestionState {
  spec: AskUserQuestionSpec;
  /** Effective options including the appended Other entry. */
  options: Array<{ label: string; description?: string }>;
  selected: Set<number>; // indices into options
  freeform: string;
}

type Phase = "options" | "freeform";

function buildState(req: AskUserRequest): QuestionState[] {
  return req.questions.map((spec) => {
    const seen = new Set(spec.options.map((o) => o.label.toLowerCase()));
    const options = [...spec.options];
    if (!seen.has(OTHER_LABEL.toLowerCase())) {
      options.push({ label: OTHER_LABEL, description: "type a custom answer" });
    }
    return { spec, options, selected: new Set<number>(), freeform: "" };
  });
}

function isAnswered(q: QuestionState): boolean {
  if (q.selected.size === 0) return false;
  const otherIdx = q.options.findIndex((o) => o.label === OTHER_LABEL);
  if (otherIdx >= 0 && q.selected.has(otherIdx) && q.freeform.trim().length === 0) {
    return false;
  }
  return true;
}

export async function askUser(req: AskUserRequest, opts: { signal?: AbortSignal } = {}): Promise<AskUserResponse> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return { answers: [], cancelled: true };
  }

  const states = buildState(req);

  return new Promise<AskUserResponse>((resolve) => {
    let tab = 0;
    let optIndex = 0;
    let phase: Phase = "options";
    let freeformBuffer = "";
    let lastRenderedRows = 0;
    let hasRendered = false;
    let settled = false;

    const onAbort = (): void => settle({ answers: [], cancelled: true });

    const settle = (value: AskUserResponse): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      try {
        if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      } catch {
        // ignore
      }
      try {
        stdin.pause();
      } catch {
        // ignore
      }
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      clearLastRender();
      resolve(value);
    };

    const onEnd = (): void => settle({ answers: [], cancelled: true });

    const clearLastRender = (): void => {
      if (!hasRendered) return;
      stdout.write(cursorUp(lastRenderedRows));
      stdout.write(cursorToCol(1));
      stdout.write(clearBelow);
      hasRendered = false;
    };

    const buildResponse = (): AskUserResponse => {
      const answers: AskUserAnswer[] = states.map((q) => {
        const selected = [...q.selected].sort((a, b) => a - b).map((i) => q.options[i]?.label ?? "");
        const otherIdx = q.options.findIndex((o) => o.label === OTHER_LABEL);
        const hasOther = otherIdx >= 0 && q.selected.has(otherIdx);
        const ans: AskUserAnswer = { selected };
        if (hasOther && q.freeform.trim().length > 0) ans.freeform = q.freeform.trim();
        return ans;
      });
      return { answers };
    };

    const renderTabs = (): string => {
      const chips = states.map((q, i) => {
        const status = isAnswered(q) ? "✓" : i === tab ? "●" : "○";
        const raw = ` ${status} ${q.spec.header} `;
        if (i === tab) return useColor ? cyan(`[${raw}]`) : `[${raw}]`;
        return useColor ? dim(`[${raw}]`) : `[${raw}]`;
      });
      return chips.join(" ");
    };

    const renderOptions = (q: QuestionState): string[] => {
      const lines: string[] = [];
      const labelW = Math.max(...q.options.map((o) => visibleWidth(o.label)));
      for (let i = 0; i < q.options.length; i++) {
        const o = q.options[i];
        if (!o) continue;
        const isCur = i === optIndex;
        const selected = q.selected.has(i);
        let marker: string;
        if (q.spec.multiSelect) {
          marker = selected ? "[x]" : "[ ]";
        } else {
          marker = selected ? "●" : "○";
        }
        const cursor = isCur ? (useColor ? cyan("❯") : "❯") : " ";
        const pad = " ".repeat(Math.max(0, labelW - visibleWidth(o.label)));
        const label = isCur && useColor ? cyan(o.label) : o.label;
        const desc = o.description
          ? `  ${useColor ? dim(o.description) : o.description}`
          : "";
        lines.push(`  ${cursor} ${marker} ${label}${pad}${desc}`);
      }
      return lines;
    };

    const renderFreeform = (q: QuestionState): string[] => {
      const prompt = useColor ? cyan("› ") : "> ";
      const placeholder = q.freeform.length === 0 && freeformBuffer.length === 0
        ? (useColor ? dim("type your custom answer, Enter to confirm, Esc to cancel") : "type your custom answer, Enter to confirm, Esc to cancel")
        : "";
      return [`  ${prompt}${freeformBuffer}${placeholder}`];
    };

    const render = (): void => {
      clearLastRender();
      const q = states[tab];
      if (!q) return;
      const lines: string[] = [];
      const total = states.length;
      const header = `\n${useColor ? bold(cyan("?")) : "?"} ${q.spec.question}`;
      lines.push(header);
      if (total > 1) lines.push(renderTabs());
      lines.push("");
      if (phase === "options") {
        lines.push(...renderOptions(q));
      } else {
        lines.push(...renderOptions(q));
        lines.push("");
        lines.push(...renderFreeform(q));
      }
      lines.push("");
      const hintParts = [
        total > 1 ? "←/→ tab" : "",
        "↑/↓ option",
        q.spec.multiSelect ? "space toggle" : "",
        phase === "freeform" ? "enter confirm · esc cancel" : "enter next/submit",
        "ctrl+c cancel",
      ].filter((x) => x.length > 0);
      lines.push(useColor ? dim(hintParts.join(" · ")) : hintParts.join(" · "));

      let rows = 0;
      for (const ln of lines) {
        stdout.write(`${ln}\n`);
        rows += ln.split("\n").length;
      }
      lastRenderedRows = rows;
      hasRendered = true;
    };

    const allAnswered = (): boolean => states.every(isAnswered);

    const advanceOrSubmit = (): void => {
      if (allAnswered()) {
        settle(buildResponse());
        return;
      }
      // Find next unanswered tab starting after current.
      for (let step = 1; step <= states.length; step++) {
        const idx = (tab + step) % states.length;
        const q = states[idx];
        if (q && !isAnswered(q)) {
          tab = idx;
          optIndex = 0;
          phase = "options";
          render();
          return;
        }
      }
      settle(buildResponse());
    };

    const commitFreeform = (q: QuestionState): void => {
      const otherIdx = q.options.findIndex((o) => o.label === OTHER_LABEL);
      if (otherIdx < 0) {
        phase = "options";
        render();
        return;
      }
      const text = freeformBuffer.trim();
      if (text.length === 0) {
        // Empty submit cancels the Other selection.
        q.selected.delete(otherIdx);
        q.freeform = "";
        freeformBuffer = "";
        phase = "options";
        render();
        return;
      }
      q.freeform = text;
      q.selected.add(otherIdx);
      if (!q.spec.multiSelect) {
        // Single-select: keep only Other.
        q.selected = new Set([otherIdx]);
      }
      freeformBuffer = "";
      phase = "options";
      if (!q.spec.multiSelect) {
        advanceOrSubmit();
      } else {
        render();
      }
    };

    const handleOptionsKey = (str: string): void => {
      const q = states[tab];
      if (!q) return;
      const otherIdx = q.options.findIndex((o) => o.label === OTHER_LABEL);

      // Tab navigation
      if (str === `${CSI}D` && states.length > 1) {
        tab = (tab - 1 + states.length) % states.length;
        optIndex = 0;
        render();
        return;
      }
      if (str === `${CSI}C` && states.length > 1) {
        tab = (tab + 1) % states.length;
        optIndex = 0;
        render();
        return;
      }
      // Tab key cycles tabs too
      if (str === "\t" && states.length > 1) {
        tab = (tab + 1) % states.length;
        optIndex = 0;
        render();
        return;
      }
      // Options navigation
      if (str === `${CSI}A`) {
        optIndex = (optIndex - 1 + q.options.length) % q.options.length;
        render();
        return;
      }
      if (str === `${CSI}B`) {
        optIndex = (optIndex + 1) % q.options.length;
        render();
        return;
      }
      // Space: multi-select toggle
      if (str === " " && q.spec.multiSelect) {
        if (optIndex === otherIdx) {
          freeformBuffer = q.freeform;
          phase = "freeform";
          render();
          return;
        }
        if (q.selected.has(optIndex)) q.selected.delete(optIndex);
        else q.selected.add(optIndex);
        render();
        return;
      }
      // Enter
      if (str === "\r" || str === "\n") {
        if (optIndex === otherIdx) {
          freeformBuffer = q.freeform;
          phase = "freeform";
          render();
          return;
        }
        if (q.spec.multiSelect) {
          // In multi-select, Enter advances if at least one answer chosen.
          if (q.selected.size === 0) {
            q.selected.add(optIndex);
          }
          if (isAnswered(q)) advanceOrSubmit();
          else render();
          return;
        }
        // Single-select: pick current option.
        q.selected = new Set([optIndex]);
        advanceOrSubmit();
        return;
      }
    };

    const handleFreeformKey = (str: string): void => {
      const q = states[tab];
      if (!q) return;
      // Esc: cancel freeform, return to options
      if (str === "\x1b") {
        freeformBuffer = "";
        phase = "options";
        render();
        return;
      }
      // Enter: commit
      if (str === "\r" || str === "\n") {
        commitFreeform(q);
        return;
      }
      // Backspace
      if (str === "\x7f" || str === "\b") {
        if (freeformBuffer.length > 0) {
          freeformBuffer = freeformBuffer.slice(0, -1);
          render();
        }
        return;
      }
      // Ignore other escape sequences
      if (str.startsWith(ESC)) return;
      const text = str.replace(/[\x00-\x1f]/g, "");
      if (text.length === 0) return;
      freeformBuffer += text;
      render();
    };

    const onData = (data: Buffer): void => {
      const str = data.toString("utf8");
      // Ctrl+C
      if (str === "\x03") {
        settle({ answers: [], cancelled: true });
        return;
      }
      if (phase === "freeform") handleFreeformKey(str);
      else handleOptionsKey(str);
    };

    if (stdin.readableEnded || stdin.destroyed) {
      resolve({ answers: [], cancelled: true });
      return;
    }
    try {
      stdin.setRawMode(true);
    } catch {
      // ignore
    }
    try {
      (stdin as { ref?: () => void }).ref?.();
    } catch {
      // ignore
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        resolve({ answers: [], cancelled: true });
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
    stdin.resume();
    render();
  });
}
