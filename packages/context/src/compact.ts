import type { MessageParam, ModelClient, ToolResultBlock } from "@nova/core";

export const COMPACT_MARKER = "[compacted]";

const DEFAULT_KEEP_RECENT = 3;
const DEFAULT_MIN_CHARS = 100;
const DEFAULT_MAX_SUMMARY_TOKENS = 2000;
const DEFAULT_CONTEXT_WINDOW_PERCENT = 0.5;
const DEFAULT_PRESERVE_TOOLS: readonly string[] = ["read"];

// ────────────────────────────────────────────────────────────────────────────
// Layer 1 — micro_compact
// ────────────────────────────────────────────────────────────────────────────

export interface MicroCompactOptions {
  /** Keep the last N tool_result blocks fully intact. Default 3. */
  keepRecent?: number;
  /** Only compact tool_result content whose string length exceeds this. Default 100. */
  minContentChars?: number;
  /** Tool names whose outputs are never compacted. Default ["read"]. */
  preserveTools?: Iterable<string>;
}

export interface MicroCompactResult {
  messages: MessageParam[];
  replaced: number;
}

/**
 * Silent, every-turn cleanup. Replace tool_result content older than the last
 * `keepRecent` with a `[Previous: used <tool>]` placeholder. Read-only tools
 * (default: `read`) are preserved because their outputs are reference material —
 * compacting them would force the agent to re-read files.
 */
export function microCompact(
  messages: MessageParam[],
  opts: MicroCompactOptions = {},
): MicroCompactResult {
  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  const minChars = opts.minContentChars ?? DEFAULT_MIN_CHARS;
  const preserve = new Set(opts.preserveTools ?? DEFAULT_PRESERVE_TOOLS);

  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") toolNameById.set(block.id, block.name);
    }
  }

  const refs: Array<{ msgIdx: number; blockIdx: number }> = [];
  messages.forEach((msg, msgIdx) => {
    if (msg.role !== "user" || typeof msg.content === "string") return;
    msg.content.forEach((block, blockIdx) => {
      if (block.type === "tool_result") refs.push({ msgIdx, blockIdx });
    });
  });

  if (refs.length <= keepRecent) return { messages, replaced: 0 };

  const toClear = refs.slice(0, refs.length - keepRecent);
  const cloned = new Map<number, MessageParam>();
  let replaced = 0;

  for (const { msgIdx, blockIdx } of toClear) {
    const orig = messages[msgIdx];
    if (!orig || orig.role !== "user" || typeof orig.content === "string") continue;
    const block = orig.content[blockIdx];
    if (!block || block.type !== "tool_result") continue;
    const text = typeof block.content === "string" ? block.content : null;
    if (text === null || text.length <= minChars) continue;
    const toolName = toolNameById.get(block.tool_use_id) ?? "unknown";
    if (preserve.has(toolName)) continue;

    const replacement: ToolResultBlock = {
      ...block,
      content: `[Previous: used ${toolName}]`,
    };
    const next =
      cloned.get(msgIdx) ?? ({ ...orig, content: [...orig.content] } as MessageParam);
    if (Array.isArray(next.content)) {
      next.content[blockIdx] = replacement;
    }
    cloned.set(msgIdx, next);
    replaced++;
  }

  if (replaced === 0) return { messages, replaced: 0 };
  const result = messages.map((m, i) => cloned.get(i) ?? m);
  return { messages: result, replaced };
}

// ────────────────────────────────────────────────────────────────────────────
// Threshold helpers
// ────────────────────────────────────────────────────────────────────────────

/** Rough token estimate (~4 chars / token), matching the reference implementation. */
export function estimateTokens(messages: MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export interface ThresholdOptions {
  /** Hard token ceiling. Wins if set. */
  thresholdTokens?: number;
  /** Otherwise: compute from context window × percent. */
  contextWindowTokens?: number;
  /** Percent of context window that triggers compaction. Default 0.5. */
  contextWindowPercent?: number;
}

export function computeThreshold(t: ThresholdOptions): number {
  if (t.thresholdTokens && t.thresholdTokens > 0) return t.thresholdTokens;
  if (t.contextWindowTokens && t.contextWindowTokens > 0) {
    const pct = t.contextWindowPercent ?? DEFAULT_CONTEXT_WINDOW_PERCENT;
    return Math.floor(t.contextWindowTokens * pct);
  }
  throw new Error(
    "computeThreshold requires either thresholdTokens or contextWindowTokens",
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
  /** Persists the pre-compact transcript and returns its path (embedded in the marker). */
  saveTranscript?: (messages: MessageParam[]) => Promise<string | undefined>;
}

export interface AutoCompactResult {
  messages: MessageParam[];
  summary: string;
  transcriptPath?: string;
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
 * Threshold-triggered (or manual) deep compaction. Persists a pre-compact
 * snapshot, asks the LLM for a continuity summary, and returns a single user
 * message that replaces the entire conversation history.
 */
export async function autoCompact(
  messages: MessageParam[],
  opts: AutoCompactOptions,
): Promise<AutoCompactResult> {
  const maxSummaryTokens = opts.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;

  let transcriptPath: string | undefined;
  if (opts.saveTranscript) {
    transcriptPath = await opts.saveTranscript(messages);
  }

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

  const header = transcriptPath
    ? `[Conversation compacted ${COMPACT_MARKER}. Pre-compact transcript: ${transcriptPath}]`
    : `[Conversation compacted ${COMPACT_MARKER}.]`;

  const newMessages: MessageParam[] = [
    { role: "user", content: `${header}\n\n${summary}` },
  ];

  return {
    messages: newMessages,
    summary,
    ...(transcriptPath ? { transcriptPath } : {}),
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
