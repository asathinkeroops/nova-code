import type { MemoryBundle } from "@nova/context";

export function buildSystemPrompt(
  workspace: string,
  memory: MemoryBundle,
  sessionId: string,
): string {
  const base = `You are a coding agent at ${workspace}. Use tools to solve tasks. Use todo tools for checklist, mark in_progress before starting, completed when done, error when failed. Act, don't explain.
<identity>
name: Nova
</identity>

<system-info>
platform: ${process.platform}
time: ${new Date().toISOString()}
</system-info>

<session>
id: ${sessionId}
</session>
`;
  if (!memory.system) return base;
  return `${base}\n${memory.system}\n`;
}
