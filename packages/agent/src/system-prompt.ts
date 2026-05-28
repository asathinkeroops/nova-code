import type { MemoryBundle } from "@nova/context";

export function buildSystemPrompt(
  workspace: string,
  memory: MemoryBundle,
  sessionId: string,
  skillsBlock = "",
): string {
  const base = `You are a coding agent at ${workspace}. Use tools to solve tasks.
- Track short checklists with createTodo / updateTodo / getTodoList / clearTodoList.
- Track multi-step plans with createTask / updateTask / getTask / getTaskList / clearTaskList.
- Run long-lived commands (dev servers, watchers, builds) with runLongRunningCommand; poll with checkLongRunningCommand.
- Load specialized knowledge with loadSkill.

Act, don't explain.

<identity name="Nova"></identity>

<system-info platform="${process.platform}"></system-info>

<session id="${sessionId}"></session>
`;
  const skills = skillsBlock ? `\n${skillsBlock}\n` : "";
  if (!memory.system) return `${base}${skills}`;
  return `${base}${skills}\n${memory.system}\n`;
}
