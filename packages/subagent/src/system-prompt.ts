import type { MemoryBundle } from "@nova/context";

/** The kind of sub-agent to spawn; selected per `createSubAgent` call. */
export type SubAgentType = "explore" | "plan" | "general-purpose";

const ROLE_LINE: Record<SubAgentType, string> = {
  "general-purpose":
    "an autonomous worker spawned by a parent agent to complete ONE focused task and report back",
  explore:
    "a read-only EXPLORE worker spawned by a parent agent to locate code and gather information, then report back",
  plan:
    "a read-only PLAN worker spawned by a parent agent to investigate a task and produce a concrete implementation plan, then report back",
};

/**
 * Extra, type-specific guidance bullets. `general-purpose` adds none (it keeps
 * the full tool set); `explore` and `plan` are read-only and steer the worker
 * toward retrieval / planning respectively.
 */
const TYPE_BULLETS: Record<SubAgentType, string[]> = {
  "general-purpose": [],
  explore: [
    "You are READ-ONLY: you have no write/edit/bash tools and cannot modify files or run commands.",
    "Your job is retrieval. Use grep/glob/read to find files, symbols, and usages fast. Report concrete file paths and line numbers.",
  ],
  plan: [
    "You are READ-ONLY: you have no write/edit/bash tools and cannot modify files or run commands.",
    "Your job is planning. Investigate the relevant code, then report a concrete step-by-step plan: which files to change, in what order, and the key tradeoffs. Do NOT implement.",
  ],
};

/**
 * System prompt for a sub-agent: an ephemeral worker spawned by a parent agent
 * to complete one focused task. The parent only ever sees the sub-agent's
 * FINAL assistant message, so the prompt leans hard on "report back concisely
 * at the end" — intermediate steps are invisible upstream.
 *
 * `type` tailors the role line and adds read-only / retrieval / planning
 * guidance for the `explore` and `plan` variants.
 */
export function buildSubAgentSystemPrompt(
  workspace: string,
  memory: MemoryBundle,
  skillsBlock = "",
  type: SubAgentType = "general-purpose",
): string {
  const typeBullets = TYPE_BULLETS[type].map((b) => `- ${b}`).join("\n");
  const extra = typeBullets ? `${typeBullets}\n` : "";
  const base = `You are a Nova sub-agent: ${ROLE_LINE[type]}.

Working directory: ${workspace}

- Use tools to complete the task yourself. Work autonomously; do not ask the parent for clarification unless you are truly blocked.
- You run in isolation. The parent sees ONLY your final message — it cannot see your intermediate steps or tool output. End by reporting results concisely: what you did, key findings, and concrete file paths / follow-ups.
- Stay within the assigned task. Do not spawn further sub-agents.
${extra}
Act, don't explain.

<identity name="Nova" role="sub-agent" type="${type}"></identity>

<system-info platform="${process.platform}"></system-info>
`;
  const skills = skillsBlock ? `\n${skillsBlock}\n` : "";
  if (!memory.system) return `${base}${skills}`;
  return `${base}${skills}\n${memory.system}\n`;
}
