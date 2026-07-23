import { markSynthetic, type MessageParam, type ToolDefinition } from "@nova/core";
import type { PermissionMode } from "./permissions.js";

interface PreRequestPayload {
  system: string;
  messages: MessageParam[];
  tools: ToolDefinition[];
  maxTokens: number;
  thinkingBudgetTokens?: number;
}

interface PreRequestOverride {
  messages?: MessageParam[];
}

export type PlanModeReminderHook = (
  payload: PreRequestPayload,
) => PreRequestOverride | undefined;

// Sent to the MODEL (not the TUI), so it stays English like the permission
// denial reason and the other model-facing reminders. Note write/edit/bash are
// still *advertised* in the tools array (removing them would bust the prefix
// cache — see CLAUDE.md), so the wording says "will be denied", NOT "you don't
// have these tools", which the model could contradict against its own tool list.
const ENTER_TEXT =
  "<plan-mode>Plan mode is now ON (read-only). The write, edit, and bash tools " +
  "are still listed but every call to them will be DENIED. Investigate the " +
  "relevant code and present a concrete step-by-step plan instead of changing " +
  "anything — you may record the intended file changes as todos, but do not try " +
  "to execute them. The user turns plan mode off (shift+tab) when they want the " +
  "plan applied.</plan-mode>";

const LEAVE_TEXT =
  "<plan-mode>Plan mode is now OFF. The write, edit, and bash tools are enabled " +
  "again — you may proceed to apply the plan.</plan-mode>";

/**
 * Returns a `pre_request` hook that announces plan-mode transitions to the
 * model, lazily. It holds no timer and starts no turn of its own: it only
 * injects when a request is genuinely about to be sent (that is what
 * `pre_request` is), and only when the plan-ness of the permission mode has
 * flipped since the model was last told. Toggling the mode and then never
 * prompting again injects nothing — there is no request to ride on.
 *
 * Because `pre_request` persists `messages` overrides into canonical history
 * (loop.ts), the reminder is seen by the model, written to messages.jsonl, and
 * rendered by the TUI — while staying a pure tail append, so the prefix cache
 * is untouched. It reads the mode live via `getMode`, so it is trigger-agnostic:
 * a human shift+tab and a future agent-driven mode switch are announced the same
 * way. The permission gate remains the sole enforcer; this is only narration.
 */
export function makePlanModeReminder(getMode: () => PermissionMode): PlanModeReminderHook {
  // Track only plan-ness: the reminder cares whether we crossed the plan
  // boundary, not e.g. default↔acceptEdits. Seed from the current mode so a
  // session that starts in plan mode does not spuriously announce on turn 1.
  let announcedPlan = getMode() === "plan";
  return ({ messages }) => {
    const isPlan = getMode() === "plan";
    if (isPlan === announcedPlan) return undefined;
    announcedPlan = isPlan;
    const injection = markSynthetic(
      { role: "user", content: [{ type: "text", text: isPlan ? ENTER_TEXT : LEAVE_TEXT }] },
      "plan-mode",
    );
    return { messages: [...messages, injection] };
  };
}
