import type { SlashOutcome } from "@nova/external";

/**
 * `/plan <task goal>` — kick off planning for a task. Returns a prompt that
 * directs the main agent to delegate the investigation to a read-only `plan`
 * sub-agent (createSubAgent type: "plan") and present the resulting
 * step-by-step plan for review, WITHOUT starting implementation.
 *
 * Pure: depends only on the args string, so it lives outside CliContext.
 */
export function handlePlan(goal: string): SlashOutcome {
  const trimmed = goal.trim();
  if (!trimmed) {
    return { kind: "error", message: "usage: /plan <task goal>" };
  }
  const text =
    "Produce a concrete implementation plan for the task below. Do NOT start " +
    "implementing — planning only.\n\n" +
    'Spawn a sub-agent with createSubAgent (type: "plan") to investigate the ' +
    "relevant code and return a step-by-step plan (which files to change, in " +
    "what order, key tradeoffs), then present that plan to me for review.\n\n" +
    `Task goal:\n${trimmed}`;
  return { kind: "prompt", text };
}
