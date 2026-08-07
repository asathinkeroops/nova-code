import {
  blocksOf,
  extractText,
  markSynthetic,
  type MessageParam,
  type ToolDefinition,
} from "@nova/core";
import { isCompactionMarker } from "@nova/context";
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
// Every enter notice opens with this, so `visiblePlanState` can tell an enter
// from a leave without knowing which exit-path variant was used (or which
// version of the copy a resumed session persisted).
const PLAN_ON_PREFIX = "<plan-mode>Plan mode is now ON";

const ENTER_BODY =
  `${PLAN_ON_PREFIX} (read-only). The write, edit, and bash tools ` +
  "are still listed but every call to them will be DENIED. Investigate the " +
  "relevant code and present a concrete step-by-step plan instead of changing " +
  "anything — you may record the intended file changes as todos, but do not try " +
  "to execute them. ";

// The exit path depends on whether the host registered the plan-mode tools
// (`settings.planMode.agentTools`); naming exitPlanMode where it is not
// registered would just buy a failed tool call.
//
// The last sentence is load-bearing: the failure it prevents is the model
// treating "go ahead and implement it" as if it lifted the mode, so it fires
// off an edit, eats a denial, and only then remembers to ask.
const ENTER_TEXT_SELF_EXIT =
  ENTER_BODY +
  "Plan mode stays ON until the user approves the plan, and only exitPlanMode " +
  "can lift it. Call exitPlanMode as soon as the plan is ready — and, if the " +
  "user tells you to go ahead and implement it while plan mode is still on, " +
  "call exitPlanMode FIRST, before any write, edit, or bash. Being told to " +
  "proceed does not turn plan mode off by itself.</plan-mode>";

const ENTER_TEXT_USER_EXIT =
  ENTER_BODY +
  "The user turns plan mode off (shift+tab) when they want the plan applied.</plan-mode>";

const LEAVE_TEXT =
  "<plan-mode>Plan mode is now OFF. The write, edit, and bash tools are enabled " +
  "again — you may proceed to apply the plan.</plan-mode>";

/**
 * What the model currently believes about plan mode, read off the view it will
 * actually be sent: the newest plan-mode notice at or after the last compaction
 * boundary (`sliceFromLastCompacted`'s window, walked in place so no array is
 * copied per request). `undefined` means no notice is visible.
 *
 * Provenance comes from `meta.kind` — never the in-band `<plan-mode>` string, so
 * a user pasting that tag cannot convince the reminder it already spoke. Only
 * once a message is known to be ours does the text decide which notice it is,
 * via `PLAN_ON_PREFIX` — a prefix rather than a whole-string match so that both
 * enter variants, and any notice an older version persisted, still read as
 * "on". `meta` predates this reminder, so every persisted notice carries the
 * tag (no legacy back-fill needed).
 */
function visiblePlanState(messages: MessageParam[]): boolean | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    // The boundary itself is the first message of the model's view, so reaching
    // it means nothing beyond is visible.
    if (isCompactionMarker(msg)) return undefined;
    if (msg.meta?.kind === "plan-mode") {
      return extractText(blocksOf(msg)).startsWith(PLAN_ON_PREFIX);
    }
  }
  return undefined;
}

/**
 * Returns a `pre_request` hook that keeps the model's view honest about plan
 * mode, lazily. It holds no timer and starts no turn of its own: it only injects
 * when a request is genuinely about to be sent (that is what `pre_request` is),
 * and only when the live mode disagrees with what the model can still see.
 * Toggling the mode and then never prompting again injects nothing — there is no
 * request to ride on.
 *
 * The comparison is against the *visible* history rather than a "have I
 * announced?" flag, which makes it self-healing across every way the model's
 * window can lose the notice while the mode stays on: compaction moves the slice
 * head past it, `/clear` starts an empty history, `/resume` switches to another
 * one, `/rewind` truncates it. A flag would stay set through all four and leave
 * the model silently unaware it is read-only until a write came back denied.
 * (It also self-heals the `pre_request` first-non-undefined-wins race: losing to
 * another injector just defers this to the next request.) The flip side is that
 * a session *opening* in plan mode (`--permission-mode plan`, or a resumed one)
 * is announced on turn 1 — the model would otherwise never be told at all.
 *
 * Because `pre_request` persists `messages` overrides into canonical history
 * (loop.ts), the reminder is seen by the model, written to messages.jsonl, and
 * rendered by the TUI — while staying a pure tail append, so the prefix cache is
 * untouched. Injecting is therefore self-limiting: the notice lands inside the
 * current slice, so the next request sees it and stays quiet. It reads the mode
 * live via `getMode`, so it is trigger-agnostic: a human shift+tab and the
 * agent's own enterPlanMode / exitPlanMode are announced the same way. The
 * permission gate remains the sole enforcer; this is only narration.
 *
 * `canSelfExit` must mirror `settings.planMode.agentTools`: it decides whether
 * the notice points the model at exitPlanMode or at the user's shift+tab.
 */
export function makePlanModeReminder(
  getMode: () => PermissionMode,
  { canSelfExit = false }: { canSelfExit?: boolean } = {},
): PlanModeReminderHook {
  const enterText = canSelfExit ? ENTER_TEXT_SELF_EXIT : ENTER_TEXT_USER_EXIT;
  return ({ messages }) => {
    const isPlan = getMode() === "plan";
    // With no notice in view the model assumes it is NOT restricted (its
    // default), so an absent notice reads as `false`, not "unknown".
    if ((visiblePlanState(messages) ?? false) === isPlan) return undefined;
    const injection = markSynthetic(
      { role: "user", content: [{ type: "text", text: isPlan ? enterText : LEAVE_TEXT }] },
      "plan-mode",
    );
    return { messages: [...messages, injection] };
  };
}
