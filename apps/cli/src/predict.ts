import {
  blocksOf,
  extractText,
  type MessageParam,
  type ModelClient,
  type StopReason,
} from "@nova/core";

export interface PredictOptions {
  model: ModelClient;
  messages: MessageParam[];
  maxChars: number;
  timeoutMs: number;
  /** Project/user memory bundle, prepended to the system prompt so predictions
   * stay grounded in the current codebase rather than generic guesses. */
  memorySystem?: string;
  signal?: AbortSignal;
}

export interface PredictResult {
  text: string | null;
  raw?: string;
  error?: string;
  /** The model's stop reason, surfaced so the caller can tell a clean end_turn
   * from a max_tokens truncation when deciding what to log. */
  stopReason?: StopReason;
}

const RECENT_MESSAGES = 6;

function formatHistory(messages: MessageParam[]): string {
  const recent = messages.slice(-RECENT_MESSAGES);
  const parts: string[] = [];
  for (const m of recent) {
    const text = extractText(blocksOf(m)).trim();
    if (!text) continue;
    const role = m.role === "user" ? "User" : "Assistant";
    parts.push(`${role}: ${text}`);
  }
  return parts.join("\n\n");
}

/** Sentence-enders we prefer to cut at so a truncated placeholder never breaks mid-sentence. */
const SENTENCE_END = new Set([..."。！？!?；;…\n"]);
/** Clause / word boundaries (comma, colon, whitespace) as a fallback cut point. */
const CLAUSE_END = new Set([..."，,、：: "]);

/**
 * Slice `text` to at most `limit` characters, but backtrack to the nearest
 * sentence end (then clause/word boundary) instead of cutting mid-sentence.
 * A placeholder that stops at a full punctuation mark reads as complete even
 * when the model overran the length budget.
 */
function truncateAtBoundary(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const head = chars.slice(0, limit);
  for (const enders of [SENTENCE_END, CLAUSE_END]) {
    for (let i = head.length - 1; i > 0; i--) {
      const ch = head[i];
      if (ch !== undefined && enders.has(ch)) return head.slice(0, i + 1).join("");
    }
  }
  return head.join("");
}

export function cleanPrediction(raw: string, maxChars: number): string | null {
  let cleaned = raw.split(/\r?\n/)[0] ?? "";
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x1f\x7f]/g, "").trim();
  cleaned = cleaned.replace(/^["'`「『（(]+|["'`」』）)]+$/g, "").trim();
  if (!cleaned) return null;
  // A boundary cut can land on a word/clause space (an English phrase), so
  // re-trim the tail — `truncateAtBoundary` only cuts, never trims.
  return truncateAtBoundary(cleaned, maxChars).trim() || null;
}

export async function predictNextInput(opts: PredictOptions): Promise<PredictResult> {
  const { model, messages, maxChars, timeoutMs, memorySystem, signal: outerSignal } = opts;
  if (messages.length === 0) return { text: null, error: "no-messages" };
  const convo = formatHistory(messages);
  if (!convo) return { text: null, error: "no-text-in-history" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  const instructions =
    `You predict the user's next TASK request to the coding agent. ` +
    `Given the conversation below between User and Assistant, output the single most likely next TASK the User would ask the agent to do. ` +
    `The prediction MUST be an actionable task — an instruction to do, change, add, fix, refactor, run, investigate, or check something. ` +
    `It must NOT be a question, a greeting, a confirmation, an acknowledgement, a thank-you, or any other non-task chat. ` +
    `Write it as ONE complete imperative sentence in the user's language (e.g. "添加 X", "修复 Y", "重构 Z", "add X", "fix Y", "refactor Z"). ` +
    `Keep it to a single line, at most ${maxChars} characters, and always finish the thought — never stop mid-sentence and never break the task across lines. ` +
    `Output ONLY that sentence: no quotes, no "User:" prefix, no markdown, no reasoning, no commentary. ` +
    `Always produce a plausible task; never refuse and never output an empty response. ` +
    `Ground the task in the project context and the immediately preceding work — propose a natural follow-up task, not an unrelated one.`;
  const system = memorySystem
    ? `<project-context>\n${memorySystem}\n</project-context>\n\n${instructions}`
    : instructions;

  const promptMessages: MessageParam[] = [
    {
      role: "user",
      content: `${convo}\n\nNext task the user would request (imperative instruction only):`,
    },
  ];

  try {
    const result = await model.call({
      system,
      messages: promptMessages,
      tools: [],
      maxTokens: Math.max(64, maxChars * 3),
      thinkingLevel: "off",
      signal: controller.signal,
    });
    const raw = extractText(result.content).trim();
    // A max_tokens stop means the model ran out of room mid-sentence, so the
    // text is a truncated fragment. Never surface it as a placeholder — no
    // prediction is better than a broken one.
    if (result.stopReason === "max_tokens") {
      return { text: null, raw, stopReason: result.stopReason, error: "truncated" };
    }
    if (!raw) {
      return { text: null, raw: "", stopReason: result.stopReason, error: "empty-text" };
    }
    const cleaned = cleanPrediction(raw, maxChars);
    return { text: cleaned, raw, stopReason: result.stopReason };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: null, error: msg };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}
