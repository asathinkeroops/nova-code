import {
  DEFAULT_TOKEN_ESTIMATE,
  estimateTextTokens,
  markSynthetic,
  type MessageParam,
  type ModelClient,
  type TokenEstimate,
} from "@nova/core";

export const COMPACT_MARKER = "[compacted]";

const DEFAULT_MAX_SUMMARY_TOKENS = 4000;
/**
 * Share of the context window that has to fill before auto-compaction fires.
 *
 * Compaction is not free: it costs a summarization call, and it resets the
 * prefix cache once (a new `<compacted>` boundary moves the model-facing slice
 * head forward — see the prefix-caching contract in CLAUDE.md). Firing at half
 * a window spent both of those while most of the window was still usable.
 */
const DEFAULT_CONTEXT_WINDOW_PERCENT = 0.9;

// ────────────────────────────────────────────────────────────────────────────
// Compaction boundary — the model-facing view of an append-only history
// ────────────────────────────────────────────────────────────────────────────

/**
 * A compaction boundary is a synthetic `user` message tagged `meta.kind ===
 * "compacted"` (produced by `autoCompact`; its content still opens with the
 * in-band `<compacted>` tag for the model to read). The full conversation
 * history stays append-only on disk and is rendered in full by the TUI; the
 * model is fed only the slice from the LAST boundary onward. Detection keys off
 * `meta` — never the string — so a user typing `<compacted>` cannot forge a
 * boundary and truncate the model's context.
 */
export function isCompactionMarker(msg: MessageParam): boolean {
  return msg.meta?.kind === "compacted";
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
 * Rough token estimate over the JSON-serialized messages, weighting CJK vs.
 * non-CJK characters per `weights` (the active provider's `tokenEstimate`; see
 * `@nova/core`'s `estimateTextTokens`). `weights` defaults to
 * {@link DEFAULT_TOKEN_ESTIMATE} for callers without a resolved profile, but
 * real callers pass the provider's ratios so a CJK-heavy conversation isn't
 * under-counted (which would trip auto-compaction too late).
 */
export function estimateTokens(
  messages: MessageParam[],
  weights: TokenEstimate = DEFAULT_TOKEN_ESTIMATE,
): number {
  return estimateTextTokens(JSON.stringify(messages), weights);
}

export interface ThresholdOptions {
  /** Hard token ceiling. Wins if set. */
  thresholdTokens?: number;
  /** Otherwise: compute from context window × percent. */
  contextWindowSize?: number;
  /** Percent of context window that triggers compaction. Default 0.9. */
  contextWindowPercent?: number;
}

export interface CompactTriggerOptions extends ThresholdOptions {
  /**
   * Tokens the request spends on everything that is not conversation — the
   * system prompt and the tool schemas, re-sent verbatim on every call.
   *
   * Counted against the threshold because it occupies the window just as the
   * messages do. Omitting it makes the threshold mean "messages only", which
   * understates usage by the whole fixed cost: with a 128k window and ~14k of
   * system + tools, a 90% trigger would not fire until the real request was
   * already at 101% of the window.
   */
  overheadTokens?: number;
}

export function computeThreshold(t: ThresholdOptions): number {
  if (t.thresholdTokens && t.thresholdTokens > 0) return t.thresholdTokens;
  if (t.contextWindowSize && t.contextWindowSize > 0) {
    const pct = t.contextWindowPercent ?? DEFAULT_CONTEXT_WINDOW_PERCENT;
    return Math.floor(t.contextWindowSize * pct);
  }
  throw new Error("computeThreshold requires either thresholdTokens or contextWindowSize");
}

export function shouldAutoCompact(
  messages: MessageParam[],
  t: CompactTriggerOptions,
  weights: TokenEstimate = DEFAULT_TOKEN_ESTIMATE,
): boolean {
  return estimateTokens(messages, weights) + (t.overheadTokens ?? 0) >= computeThreshold(t);
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
  "You are an AI coding agent compacting your own conversation so you can keep working after " +
  "the older messages are dropped from your context. The summary you write REPLACES that history — " +
  "it is the only memory of it you will have. Capture everything needed to resume without re-reading. " +
  "Preserve concrete details (file paths, symbols, commands, error text) verbatim. " +
  "Output only the summary — no preamble.";

const SUMMARY_INSTRUCTIONS = [
  "Write a structured summary so you can seamlessly continue the work.",
  "Use these sections; drop one only if genuinely empty:",
  "",
  "## Goal",
  "The user's original request and current objective — in their words where wording matters.",
  "## Progress so far",
  "What is done and verified, with the concrete files / functions / commands involved.",
  "## Current state",
  "The exact point work is at right now — what was just underway and the immediate next step.",
  "## Problems & dead-ends",
  "Errors hit, failed approaches, and options ruled out, so they aren't retried.",
  "## Decisions & constraints",
  "Design choices and why; user preferences, instructions, or restrictions to honor.",
  "## Key references",
  "Specific paths, symbols, commands, test names, and short critical code/config snippets to keep verbatim.",
  "",
  "Prefer detail over brevity; when in doubt, keep it.",
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

  // Wrap in a <compacted> tag so the model reads the summary, and stamp
  // meta.kind so the slice/TUI recognize the boundary structurally (not by the
  // forgeable tag string). The TUI skips the bubble via meta.synthetic.
  const newMessages: MessageParam[] = [
    markSynthetic(
      { role: "user", content: `<compacted>\n${header}\n\n${summary}\n</compacted>` },
      "compacted",
    ),
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
