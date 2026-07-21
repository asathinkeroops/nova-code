import type { MemoryBundle } from "@nova/context";
import type { AgentDefinition } from "./definitions.js";

/**
 * System prompt for a sub-agent: an ephemeral worker spawned by a parent agent
 * to complete one focused task. The parent only ever sees the sub-agent's
 * FINAL assistant message, so the prompt leans hard on "report back concisely
 * at the end" — intermediate steps are invisible upstream.
 *
 * The `def` supplies the role line and any extra guidance (built-in
 * read-only / retrieval / planning bullets, or a custom agent's markdown
 * body). The surrounding scaffolding — isolation rules, report-back
 * discipline, identity, system-info — is fixed so every sub-agent behaves
 * consistently regardless of type.
 */
export function buildSubAgentSystemPrompt(
  workspace: string,
  memory: MemoryBundle,
  skillsBlock: string,
  def: Pick<AgentDefinition, "name" | "roleLine" | "guidance">,
): string {
  const trimmedGuidance = def.guidance.trim();
  const extra = trimmedGuidance ? `${trimmedGuidance}\n` : "";
  const base = `You are a Nova sub-agent: ${def.roleLine}.

Working directory: ${workspace}

- Use tools to complete the task yourself. Work autonomously; do not ask the parent for clarification unless you are truly blocked.
- You run in isolation. The parent sees ONLY your final message — it cannot see your intermediate steps or tool output. End by reporting results concisely: what you did, key findings, and concrete file paths / follow-ups.
- Stay within the assigned task. Do not spawn further sub-agents.
- Don't guess file paths. When unsure whether a file or directory exists, locate it with glob/grep/ls before acting — read, write, edit, or mkdir.
- Write your final report in the language of the task you were given, matching its exact script and regional variant (e.g. Simplified vs Traditional Chinese — don't switch a Simplified-Chinese task to Traditional), not the language of these instructions.
${extra}
Act, don't explain.

<identity name="Nova" role="sub-agent" type="${def.name}"></identity>

<system-info platform="${process.platform}"></system-info>
`;
  const skills = skillsBlock ? `\n${skillsBlock}\n` : "";
  if (!memory.system) return `${base}${skills}`;
  return `${base}${skills}\n${memory.system}\n`;
}
