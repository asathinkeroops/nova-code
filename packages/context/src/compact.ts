import type { MessageParam, ModelClient } from "@nova/core";

export const COMPACT_MARKER = "[compacted]";

/** Opening tag marking a message as a compaction boundary + summary. */
const COMPACT_TAG = "<compacted>";

const DEFAULT_MAX_SUMMARY_TOKENS = 2000;
const DEFAULT_CONTEXT_WINDOW_PERCENT = 0.5;

// ────────────────────────────────────────────────────────────────────────────
// Compaction boundary — the model-facing view of an append-only history
// ────────────────────────────────────────────────────────────────────────────

/**
 * A compaction boundary is a synthetic `user` message whose string content
 * opens with `<compacted>` (produced by `autoCompact`). The full conversation
 * history stays append-only on disk and is rendered in full by the TUI; the
 * model is fed only the slice from the LAST boundary onward.
 */
export function isCompactionMarker(msg: MessageParam): boolean {
  return (
    msg.role === "user" &&
    typeof msg.content === "string" &&
    msg.content.trimStart().startsWith(COMPACT_TAG)
  );
}

/**
 * The model-facing view of an append-only history: every message from the last
 * compaction boundary onward (inclusive). With no boundary the array is returned
 * unchanged. The boundary is always a `user` message, so the slice is a valid
 * request prefix and never splits a tool_use/tool_result pair.
 */
export function sliceFromLastCompacted(messages: MessageParam[]): MessageParam[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactionMarker(messages[i]!)) return messages.slice(i);
  }
  return messages;
}

// ────────────────────────────────────────────────────────────────────────────
// Threshold helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Rough token estimate using DeepSeek's documented ratios: English chars ≈ 0.3
 * tokens/char, CJK chars ≈ 0.6 tokens/char. We use 0.3 for the whole
 * JSON-serialized blob as a conservative single-pass approximation (the
 * structural JSON overhead is ASCII, and most message content is Latin).
 */
export function estimateTokens(messages: MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length * 0.3);
}

export interface ThresholdOptions {
  /** Hard token ceiling. Wins if set. */
  thresholdTokens?: number;
  /** Otherwise: compute from context window × percent. */
  contextWindowSize?: number;
  /** Percent of context window that triggers compaction. Default 0.5. */
  contextWindowPercent?: number;
}

export function computeThreshold(t: ThresholdOptions): number {
  if (t.thresholdTokens && t.thresholdTokens > 0) return t.thresholdTokens;
  if (t.contextWindowSize && t.contextWindowSize > 0) {
    const pct = t.contextWindowPercent ?? DEFAULT_CONTEXT_WINDOW_PERCENT;
    return Math.floor(t.contextWindowSize * pct);
  }
  throw new Error(
    "computeThreshold requires either thresholdTokens or contextWindowSize",
  );
}

export function shouldAutoCompact(messages: MessageParam[], t: ThresholdOptions): boolean {
  return estimateTokens(messages) >= computeThreshold(t);
}

// ────────────────────────────────────────────────────────────────────────────
// Layer 2 — auto_compact
// ────────────────────────────────────────────────────────────────────────────

export interface AutoCompactOptions {
  model: ModelClient;
  /** Optional override for the summarizer system prompt. */
  system?: string;
  /** Free-form focus hint forwarded to the summarizer (e.g. `/compact <focus>`). */
  focus?: string;
  /** Cap on the summary response. Default 2000 tokens. */
  maxSummaryTokens?: number;
}

export interface AutoCompactResult {
  messages: MessageParam[];
  summary: string;
  usage?: { inputTokens: number; outputTokens: number };
}

const DEFAULT_SUMMARY_SYSTEM =
  "You compress conversation history for an AI coding agent. Output only the summary text — no preamble.";

const SUMMARY_INSTRUCTIONS = [
  "Summarize this conversation for continuity. Include:",
  "1) What was accomplished,",
  "2) Current state of files / tasks,",
  "3) Key decisions and any open questions.",
  "Be concise but preserve critical details.",
].join("\n");

/**
 * Threshold-triggered (or manual) deep compaction. Asks the LLM for a
 * continuity summary and returns a single `user` message (tagged `<compacted>`)
 * that callers APPEND to the append-only history as a new compaction boundary —
 * the model then reads only from that boundary onward (see
 * `sliceFromLastCompacted`), while the full history is retained on disk.
 */
export async function autoCompact(
  messages: MessageParam[],
  opts: AutoCompactOptions,
): Promise<AutoCompactResult> {
  const maxSummaryTokens = opts.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;

  const conversationText = JSON.stringify(messages);
  const focusLine = opts.focus ? `\n\nFocus on: ${opts.focus}` : "";
  const userText = `${SUMMARY_INSTRUCTIONS}${focusLine}\n\n${conversationText}`;

  const res = await opts.model.call({
    system: opts.system ?? DEFAULT_SUMMARY_SYSTEM,
    messages: [{ role: "user", content: userText }],
    tools: [],
    maxTokens: maxSummaryTokens,
  });

  const summary =
    res.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() || "No summary generated.";

  const header = `[Conversation compacted ${COMPACT_MARKER}. Full history retained in messages.jsonl.]`;

  // Wrap in a <compacted> tag so the model reads the summary while the TUI skips
  // its bubble (same convention as <reminder>/<background-command>; the renderer
  // matches the opening tag in apps/cli/src/ui/render-item.ts).
  const newMessages: MessageParam[] = [
    { role: "user", content: `<compacted>\n${header}\n\n${summary}\n</compacted>` },
  ];

  return {
    messages: newMessages,
    summary,
    ...(res.usage
      ? {
          usage: {
            inputTokens: res.usage.inputTokens,
            outputTokens: res.usage.outputTokens,
          },
        }
      : {}),
  };
}
