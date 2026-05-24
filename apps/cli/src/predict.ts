import {
  blocksOf,
  extractText,
  type MessageParam,
  type ModelClient,
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

function cleanPrediction(raw: string, maxChars: number): string | null {
  let cleaned = raw.split(/\r?\n/)[0] ?? "";
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x1f\x7f]/g, "").trim();
  cleaned = cleaned.replace(/^["'`「『（(]+|["'`」』）)]+$/g, "").trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  if (chars.length > maxChars) cleaned = chars.slice(0, maxChars).join("");
  return cleaned || null;
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
    `Given the conversation below between User and Assistant, output the most likely next TASK the User would ask the agent to do. ` +
    `The prediction MUST be an actionable task — an instruction to do, change, add, fix, refactor, run, investigate, or check something. ` +
    `It must NOT be a question, a greeting, a confirmation, an acknowledgement, a thank-you, or any other non-task chat. ` +
    `Phrase it as an imperative instruction (e.g. "添加 X", "修复 Y", "重构 Z", "add X", "fix Y", "refactor Z"). ` +
    `Output ONLY the predicted task text — no quotes, no "User:" prefix, no markdown, no commentary. ` +
    `Be concise: ${maxChars} characters or fewer. Match the user's language. ` +
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
      thinkingBudgetTokens: 0,
      signal: controller.signal,
    });
    const raw = extractText(result.content).trim();
    if (!raw) return { text: null, raw: "", error: "empty-text" };
    const cleaned = cleanPrediction(raw, maxChars);
    return { text: cleaned, raw };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: null, error: msg };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}
