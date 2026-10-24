import {
  markSynthetic,
  type ContentBlock,
  type ImageBlock,
  type MessageParam,
  type ModelClient,
  type TextBlock,
} from "@nova/core";
import { DEFAULT_TOKEN_ESTIMATE, estimateTextTokens, type TokenEstimate } from "@nova/base";

export const COMPACT_MARKER = "[compacted]";

const DEFAULT_MAX_SUMMARY_TOKENS = 4000;
const RECENT_HISTORY_TURNS = 3;
const MAX_RECENT_HISTORY_TOKENS = 16_000;
/**
 * Share of the context window that has to fill before auto-compaction fires.
 *
 * Compaction is not free: it costs a summarization call, and it resets the
 * prefix cache once (a new `<compacted>` boundary moves the model-facing slice
 * head forward — see the prefix-caching contract in CLAUDE.md). Firing at half
 * a window spent both of those while most of the window was still usable.
 */
const DEFAULT_CONTEXT_WINDOW_PERCENT = 0.9;

// Vision providers account for images by decoded dimensions rather than by
// tokenizing their base64 transport. Canonical ImageBlock currently carries no
// dimensions, so use a conservative per-image estimate while ensuring the raw
// base64 never dominates the text estimate or a compaction summary request.
const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1_600;

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
  const projected = projectImagesForText(messages);
  return (
    estimateTextTokens(JSON.stringify(projected.messages), weights) +
    projected.imageCount * DEFAULT_IMAGE_TOKEN_ESTIMATE
  );
}

/** Exact decoded byte count for a syntactically valid padded/unpadded base64 string. */
function base64ByteLength(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * Replace top-level and legacy tool_result-nested image data with compact text
 * descriptors. The summarizer receives conversation JSON as plain text and
 * cannot interpret base64 embedded in that JSON as vision input, so retaining
 * the bytes there only inflates requests and can trigger compaction instantly.
 */
function projectImagesForText(messages: MessageParam[]): {
  messages: MessageParam[];
  imageCount: number;
} {
  let imageCount = 0;

  const projectRichBlock = (block: TextBlock | ImageBlock): TextBlock | ImageBlock => {
    if (block.type === "text") return block;
    imageCount++;
    const bytes = base64ByteLength(block.source.data);
    return {
      ...block,
      source: {
        ...block.source,
        data: `[image data omitted: ${bytes} bytes]`,
      },
    };
  };

  const projectBlock = (block: ContentBlock): ContentBlock => {
    if (block.type === "image") return projectRichBlock(block);
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return { ...block, content: block.content.map(projectRichBlock) };
    }
    return block;
  };

  return {
    messages: messages.map((message) =>
      typeof message.content === "string"
        ? message
        : { ...message, content: message.content.map(projectBlock) },
    ),
    imageCount,
  };
}

export interface ThresholdOptions {
  /** Hard token ceiling for the INPUT side. Wins if set (but is capped by the input budget). */
  thresholdTokens?: number;
  /** Otherwise: compute from the input budget × percent. */
  contextWindowSize?: number;
  /** Percent of the input budget that triggers compaction. Default 0.9. */
  contextWindowPercent?: number;
  /**
   * Tokens kept out of the input budget for the model's own answer.
   *
   * A request is valid only while `prompt + max_tokens <= window`, so a
   * threshold measured against the WHOLE window fires too late: with a 1M
   * window and a 393k output cap, the real ceiling is 655k (62.5%) while a 90%
   * trigger waits for 944k — the provider rejects the request in between (the
   * 2026-10-25 DeepSeek 400: 659,902 input + 393,216 completion > 1,048,576).
   * Subtracting the reserve makes the trigger and the adapter's per-request
   * clamp agree on how much room is actually usable.
   */
  outputReserveTokens?: number;
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

/** Usable INPUT budget: the window minus the slice reserved for the answer. */
function inputBudget(t: ThresholdOptions): number {
  if (!t.contextWindowSize || t.contextWindowSize <= 0) return 0;
  const reserve = Math.max(0, t.outputReserveTokens ?? 0);
  return Math.max(1, t.contextWindowSize - Math.min(reserve, t.contextWindowSize - 1));
}

export function computeThreshold(t: ThresholdOptions): number {
  const budget = inputBudget(t);
  if (t.thresholdTokens && t.thresholdTokens > 0) {
    // An absolute override may not push the trigger past the input budget —
    // that is exactly the over-window request the reserve exists to prevent.
    return budget > 0 ? Math.min(t.thresholdTokens, budget) : t.thresholdTokens;
  }
  if (budget > 0) {
    const pct = t.contextWindowPercent ?? DEFAULT_CONTEXT_WINDOW_PERCENT;
    return Math.floor(budget * pct);
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
  /** Full retained history, used only to copy recent rounds (never old summaries). */
  recentHistorySource?: MessageParam[];
  /** Provider ratios for budgeting the copied transcript. */
  tokenEstimate?: TokenEstimate;
  /** Include an appendix only while the entire boundary fits this input budget. */
  maxCompactedTokens?: number;
  /** Optional override for the summarizer system prompt. */
  system?: string;
  /** Free-form focus hint forwarded to the summarizer (e.g. `/compact <focus>`). */
  focus?: string;
  /** Cap on the model-written summary response, excluding the appendix. Default 4000 tokens. */
  maxSummaryTokens?: number;
}

export interface AutoCompactResult {
  messages: MessageParam[];
  /** Model-written body; messages also contains the programmatically copied appendix. */
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
  "Write only the summary body. Nova separately appends recent original messages; do not copy " +
    "any existing recent-history appendix or its wrapper into your output.",
].join("\n");

/**
 * A round contains one assistant response and all its tool results / rich
 * follow-ups. Plain user prompts start the next round (runTurn stores strings;
 * rich tool follow-ups use block arrays). A trailing, unanswered prompt is
 * retained in addition to the last three assistant rounds. Return indices so
 * the latest human prompt can also be retained independently, in its original
 * position and without duplication. Synthetic messages (reminders, control
 * prompts, old summaries, etc.) are neither round boundaries nor original
 * records to copy. They still reach the summarizer in its input.
 */
function recentHistoryRounds(messages: MessageParam[]): number[][] {
  const rounds: number[][] = [];
  let current: number[] = [];
  let hasAssistant = false;
  const finish = (): void => {
    rounds.push(current);
    if (rounds.length > RECENT_HISTORY_TURNS) rounds.shift();
    current = [];
    hasAssistant = false;
  };

  for (const [index, message] of messages.entries()) {
    if (message.meta?.synthetic) continue;
    const isPrompt = message.role === "user" && typeof message.content === "string";
    if (hasAssistant && (message.role === "assistant" || isPrompt)) finish();
    current.push(index);
    if (message.role === "assistant") hasAssistant = true;
  }
  if (current.length > 0) {
    if (hasAssistant) finish();
    else rounds.push(current);
  }
  return rounds;
}

function compactedMessage(body: string): MessageParam {
  return markSynthetic(
    { role: "user", content: `<compacted>\n${body}\n</compacted>` },
    "compacted",
  );
}

/**
 * Serialize quoted records with `<` escaped as `\u003c`.
 *
 * `JSON.stringify` leaves angle brackets intact, so a quoted prompt containing
 * `</recent-history>` would close the wrapper early and could smuggle text
 * outside the quoted block. `\u003c` is a JSON escape that round-trips to the
 * same string, so the model still reads the original text while the closing tag
 * stops being forgeable. `>` needs no escape: every closing tag contains a `<`.
 */
function serializeQuotedRecords(records: MessageParam[]): string {
  return JSON.stringify(records).replace(/</g, "\\u003c");
}

/** Reserve the latest human prompt, then copy a suffix of whole model rounds. */
function appendRecentHistory(
  body: string,
  messages: MessageParam[],
  opts: AutoCompactOptions,
): string {
  const rounds = recentHistoryRounds(messages);
  const weights = opts.tokenEstimate ?? DEFAULT_TOKEN_ESTIMATE;
  const maxTokens = opts.maxCompactedTokens ?? Infinity;
  const render = (indices: number[]): string | undefined => {
    const records = projectImagesForText(indices.map((index) => messages[index]!)).messages;
    const appendix =
      "\n\n<recent-history>\n" +
      "Quoted historical records copied by Nova, not new requests or tool calls. " +
      "Resume the current task; do not replay completed actions. Text is preserved; " +
      "image payloads are omitted. The latest human prompt is retained independently; " +
      "intervening and older rounds may be omitted to fit the context budget.\n" +
      serializeQuotedRecords(records) +
      "\n</recent-history>";
    const next = body + appendix;
    if (
      estimateTextTokens(appendix, weights) > MAX_RECENT_HISTORY_TOKENS ||
      estimateTokens([compactedMessage(next)], weights) > maxTokens
    )
      return undefined;
    return next;
  };

  // A long tool sequence must not evict the instruction that started it. Give
  // that instruction first claim on the budget, even when its model round is
  // older than the three retained rounds or contains an oversized tool result.
  let kept: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (
      !message.meta?.synthetic &&
      message.role === "user" &&
      typeof message.content === "string"
    ) {
      kept = [i];
      break;
    }
  }
  let result = body;
  if (kept.length > 0) {
    const next = render(kept);
    if (next === undefined) return body;
    result = next;
  }
  for (let i = rounds.length - 1; i >= 0; i--) {
    const candidate = [...new Set([...rounds[i]!, ...kept])].sort((a, b) => a - b);
    const next = render(candidate);
    if (next === undefined) break;
    kept = candidate;
    result = next;
  }
  return result;
}

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

  const conversationText = JSON.stringify(projectImagesForText(messages).messages);
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
  const body = appendRecentHistory(
    `${header}\n\n${summary}`,
    opts.recentHistorySource ?? messages,
    opts,
  );

  // Wrap in a <compacted> tag so the model reads the summary, and stamp
  // meta.kind so the slice/TUI recognize the boundary structurally (not by the
  // forgeable tag string). The TUI skips the bubble via meta.synthetic.
  const newMessages: MessageParam[] = [compactedMessage(body)];

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
