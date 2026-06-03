import type { SlashOutcome } from "@nova/external";
import type { CliContext } from "../context.js";

/**
 * `/agent <name> <task>` — delegate a task to a named sub-agent. Resolves the
 * name against the registry (built-ins + custom defs) and returns a prompt that
 * directs the main agent to spawn that sub-agent via createSubAgent and report
 * its result back. Errors early on an unknown name so the user isn't left
 * guessing why nothing ran.
 */
export function handleAgent(ctx: CliContext, args: string): SlashOutcome {
  if (!ctx.settings.subagent.enabled) {
    return { kind: "error", message: "sub-agents are disabled in settings." };
  }
  const trimmed = args.trim();
  const sep = trimmed.search(/\s/);
  const name = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const task = sep === -1 ? "" : trimmed.slice(sep + 1).trim();

  if (!name) {
    return { kind: "error", message: "usage: /agent <name> <task>" };
  }
  if (!ctx.agents.get(name)) {
    return {
      kind: "error",
      message: `unknown sub-agent "${name}". available: ${ctx.agents.names().join(", ")}.`,
    };
  }
  if (!task) {
    return { kind: "error", message: `usage: /agent ${name} <task>` };
  }

  const text =
    `Use createSubAgent with type "${name}" to handle the task below, then report ` +
    `its result back to me. Make the sub-agent's prompt self-contained.\n\n` +
    `Task:\n${task}`;
  return { kind: "prompt", text };
}
