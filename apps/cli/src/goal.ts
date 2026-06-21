import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { blocksOf, type ContentBlock, type MessageParam } from "@nova/core";

/**
 * Active goal for a session. Mirrors Claude Code's `/goal`: after each turn an
 * evaluator agent judges whether `condition` is satisfied; if not, the REPL
 * auto-continues with feedback. Persisted to `{session.dir}/goal.json` so an
 * active goal survives `--resume` / `/resume`.
 */
export interface GoalState {
  /** The success condition the agent works toward, in the user's own words. */
  condition: string;
  /** Epoch ms when the goal was set (for `/goal` status display). */
  setAt: number;
  /** Consecutive auto-continuations spent so far (capped by settings). */
  continuations: number;
}

export interface GoalVerdict {
  met: boolean;
  /** One-line rationale, fed back to the agent as guidance when not met. */
  reason: string;
  /** The evaluator's raw final text, for logging. */
  raw: string;
}

function goalPath(sessionDir: string): string {
  return join(sessionDir, "goal.json");
}

function isGoalState(v: unknown): v is GoalState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.condition === "string" &&
    o.condition.length > 0 &&
    typeof o.setAt === "number" &&
    typeof o.continuations === "number"
  );
}

/** Read the persisted goal, or null when absent / malformed. Never throws. */
export async function loadGoal(sessionDir: string): Promise<GoalState | null> {
  try {
    const raw = await readFile(goalPath(sessionDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isGoalState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the goal atomically (write-temp + rename). */
export async function saveGoal(sessionDir: string, state: GoalState): Promise<void> {
  const path = goalPath(sessionDir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, path);
}

/** Remove the persisted goal. No-op when it is already absent. */
export async function clearGoal(sessionDir: string): Promise<void> {
  try {
    await unlink(goalPath(sessionDir));
  } catch {
    // already gone — nothing to clear
  }
}

const RECENT_MESSAGES = 16;
const MAX_BLOCK_CHARS = 2_000;
const MAX_DIGEST_CHARS = 12_000;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}… [+${s.length - n} chars]`;
}

/**
 * Render one content block into an evidence line, or null to skip it. Tool
 * results and tool calls are included (truncated) so the evaluator sees what the
 * main agent already did before deciding whether to re-verify with its own tools.
 */
function renderBlock(b: ContentBlock): string | null {
  switch (b.type) {
    case "text": {
      const t = b.text.trim();
      return t || null;
    }
    case "tool_use":
      return `[tool ${b.name}] ${truncate(JSON.stringify(b.input), 600)}`;
    case "tool_result": {
      const content =
        typeof b.content === "string"
          ? b.content
          : b.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
      const tag = b.is_error ? "tool result ERROR" : "tool result";
      return `[${tag}] ${truncate(content.trim(), MAX_BLOCK_CHARS)}`;
    }
    default:
      // thinking / redacted_thinking / image — no textual evidence value here
      return null;
  }
}

/** Flatten the recent transcript tail into plain evidence text for the judge. */
export function digestMessages(messages: MessageParam[]): string {
  const recent = messages.slice(-RECENT_MESSAGES);
  const lines: string[] = [];
  for (const m of recent) {
    const role = m.role === "user" ? "User" : "Assistant";
    for (const b of blocksOf(m)) {
      const rendered = renderBlock(b);
      if (rendered) lines.push(`${role}: ${rendered}`);
    }
  }
  const out = lines.join("\n");
  // Keep the TAIL (most recent evidence) when over budget.
  return out.length > MAX_DIGEST_CHARS ? out.slice(out.length - MAX_DIGEST_CHARS) : out;
}

/** Marker the evaluator must end on; parsed by {@link parseVerdict}. */
export const VERDICT_RE = /VERDICT:\s*(NOT[\s_]*MET|MET)/i;

/**
 * System prompt for the goal evaluator agent. It has the full tool set and is
 * told to VERIFY against the real current state (run tests, read files, fetch
 * data) — not to fix anything — then end on a `VERDICT:` line.
 */
export const GOAL_EVAL_SYSTEM =
  "You are Nova's goal-completion evaluator. Decide whether a stated GOAL is " +
  "FULLY satisfied right now, then report a verdict.\n\n" +
  "You have the full tool set (read, grep, glob, bash, webfetch, lsp, …). Use " +
  "them to VERIFY the goal against the real current state — run the tests, read " +
  "the files, fetch the data, whatever the goal actually requires. Prefer hard " +
  "evidence over the prior conversation. Investigate efficiently, then stop.\n\n" +
  "You are a JUDGE, not a worker: do NOT modify files or try to make the goal " +
  "pass yourself. Only inspect and verify.\n\n" +
  "Your FINAL message MUST contain a line in exactly this form:\n" +
  "VERDICT: MET\n" +
  "or\n" +
  "VERDICT: NOT_MET\n" +
  "followed by a one-sentence reason in the user's language. If you cannot " +
  "gather enough evidence that the goal holds, the verdict is NOT_MET.";

/** Build the evaluator's user prompt: the goal plus recent-conversation context. */
export function buildGoalEvalPrompt(condition: string, messages: MessageParam[]): string {
  const digest = digestMessages(messages);
  return (
    `GOAL:\n${condition}\n\n` +
    "Recent conversation (context for what was already attempted — verify against " +
    `the real current state, not just this):\n${digest || "(empty)"}\n\n` +
    "Verify whether the goal is met and end with the VERDICT line."
  );
}

/** Map the evaluator's final text to a verdict. Defaults to NOT met on doubt. */
export function parseVerdict(raw: string): GoalVerdict {
  const text = raw.trim();
  const m = text.match(VERDICT_RE);
  if (m) {
    const met = !/NOT/i.test(m[1] ?? "");
    const after = text.slice((m.index ?? 0) + m[0].length).replace(/^[\s.:—-]+/, "").trim();
    const reason = after || text;
    return { met, reason, raw };
  }
  // Fallbacks for an evaluator that didn't follow the VERDICT format.
  const upper = text.toUpperCase();
  if (/NOT[\s_]*MET/.test(upper)) return { met: false, reason: text, raw };
  if (/\bMET\b/.test(upper)) return { met: true, reason: text, raw };
  return { met: false, reason: text || "evaluator returned no clear verdict", raw };
}
