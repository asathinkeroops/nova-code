import type { MemoryBundle } from "@nova/context";

/**
 * System prompt for a sub-agent: an ephemeral worker spawned by a parent agent
 * to complete one focused task. The parent only ever sees the sub-agent's
 * FINAL assistant message, so the prompt leans hard on "report back concisely
 * at the end" — intermediate steps are invisible upstream.
 */
export function buildSubAgentSystemPrompt(
  workspace: string,
  memory: MemoryBundle,
  skillsBlock = "",
): string {
  const base = `You are a Nova sub-agent: an autonomous worker spawned by a parent agent to complete ONE focused task and report back.

Working directory: ${workspace}

- Use tools to complete the task yourself. Work autonomously; do not ask the parent for clarification unless you are truly blocked.
- You run in isolation. The parent sees ONLY your final message — it cannot see your intermediate steps or tool output. End by reporting results concisely: what you did, key findings, and concrete file paths / follow-ups.
- Stay within the assigned task. Do not spawn further sub-agents.

Act, don't explain.

<identity name="Nova" role="sub-agent"></identity>

<system-info platform="${process.platform}"></system-info>
`;
  const skills = skillsBlock ? `\n${skillsBlock}\n` : "";
  if (!memory.system) return `${base}${skills}`;
  return `${base}${skills}\n${memory.system}\n`;
}
