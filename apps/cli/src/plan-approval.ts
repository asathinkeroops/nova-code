import type { AskUserFn } from "@nova/core";
import { t } from "./i18n/index.js";
import type { PermissionMode } from "./permissions.js";

/** What the user answered when asked to approve a plan. */
export interface PlanApproval {
  /** True only on the explicit approve option; the mode has already been flipped. */
  approved: boolean;
  /** Freeform text typed instead of approving — a revision request, not consent. */
  feedback?: string;
  /** Nobody answered (prompt dismissed, or the turn was aborted). */
  cancelled?: boolean;
}

/** The screen surface this needs; a subset of `Screen` so tests can fake it. */
export interface PlanApprovalScreen {
  getPermissionMode(): PermissionMode;
  getModeBeforePlan(): PermissionMode | null;
  setPermissionMode(mode: PermissionMode): void;
}

/**
 * Ask the user whether to leave plan mode and implement the plan, and — on
 * approval — flip the mode back on their behalf.
 *
 * The flip lives HERE, not at either call site, because both of them (the
 * `exitPlanMode` tool and the REPL's end-of-turn gate) must agree on it: the
 * user approving is what lifts plan mode, and it restores the mode they were in
 * before rather than a fixed default. The plan itself is deliberately not
 * drawn here: the transcript above the prompt already shows it, either as the
 * model's own prose or — when the model only passed it to `exitPlanMode` — as
 * that argument rendered in place of the call's hidden row (`planToRender`).
 */
export async function askPlanApproval(
  askUser: AskUserFn,
  screen: PlanApprovalScreen,
): Promise<PlanApproval> {
  const res = await askUser({
    questions: [
      {
        question: t.planMode.question,
        header: t.planMode.header,
        options: [
          { label: t.planMode.approve, description: t.planMode.approveHint },
          { label: t.planMode.reject, description: t.planMode.rejectHint },
        ],
        multiSelect: false,
      },
    ],
  });
  const answer = res.answers[0];
  if (res.cancelled || !answer) return { approved: false, cancelled: true };
  // Only the literal approve option approves; the auto-appended "Other"
  // freeform is feedback to revise against, never consent.
  if (answer.selected.includes(t.planMode.approve)) {
    // `default` only as a floor: modeBeforePlan is null just when plan mode is
    // already off, which the gate below prevents and the tool rejects earlier.
    screen.setPermissionMode(screen.getModeBeforePlan() ?? "default");
    return { approved: true };
  }
  return { approved: false, ...(answer.freeform ? { feedback: answer.freeform } : {}) };
}

/**
 * Whether the REPL should raise the approval prompt itself, checked once per
 * pass through the idle loop.
 *
 * This is the deterministic half of plan mode. Entering it is a judgement call
 * (the model's `enterPlanMode`, or the user's shift+tab), but leaving it must
 * not be: the model forgetting to call `exitPlanMode` used to strand the
 * session read-only until a write came back denied. With this gate the exit is
 * the host's, driven by a turn ending rather than by the model electing to ask.
 *
 * `askedThisTurn` is what keeps the two paths from doubling up: when the model
 * did call `exitPlanMode` and the user said no, the turn ends still in plan
 * mode, and without this the gate would immediately ask the very same question
 * again.
 */
export function shouldGatePlanApproval(state: {
  /** `settings.planMode.approvalGate`. */
  enabled: boolean;
  mode: PermissionMode;
  /** A turn completed (not aborted) since the gate last ran. */
  armed: boolean;
  /** The `exitPlanMode` tool already asked during that turn. */
  askedThisTurn: boolean;
  /** A turn is still running — the REPL is not idle. */
  busy: boolean;
}): boolean {
  return (
    state.enabled && state.mode === "plan" && state.armed && !state.askedThisTurn && !state.busy
  );
}

/**
 * The user turn injected after an approval. Marked synthetic by the caller so
 * the TUI does not render it as something the user typed.
 *
 * It carries the approval only — no copy of the plan. The plan is already in
 * the history the model is about to be sent, so repeating it would just spend
 * tokens on a duplicate.
 */
export const PLAN_APPROVED_PROMPT =
  "<plan-approved>The user approved your plan. Plan mode is OFF — the write, edit, bash, and " +
  "monitor tools are enabled again. Implement the plan you just presented, starting now. Do not " +
  "re-present it or ask again for approval you already have.</plan-approved>";
