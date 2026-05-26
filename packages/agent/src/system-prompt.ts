import type { MemoryBundle } from "@nova/context";

export function buildSystemPrompt(
  workspace: string,
  memory: MemoryBundle,
  sessionId: string,
  skillsBlock = "",
): string {
  const base = `You are a coding agent at ${workspace}. Use tools to solve tasks. 
- Use todo tools for short checklists.
- Use task tools for multi-step work.
- Use loadSkill to access specialized knowledge.

Act, don't explain.

<identity name="Nova"></identity>

<system-info platform="${process.platform}"></system-info>

<session id="${sessionId}"></session>
`;
  const skills = skillsBlock ? `\n${skillsBlock}\n` : "";
  if (!memory.system) return `${base}${skills}`;
  return `${base}${skills}\n${memory.system}\n`;
}
