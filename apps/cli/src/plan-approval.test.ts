import { describe, expect, it } from "vitest";
import type { AskUserFn, AskUserResponse } from "@nova/core";
import {
  askPlanApproval,
  shouldGatePlanApproval,
  PLAN_APPROVED_PROMPT,
  type PlanApprovalScreen,
} from "./plan-approval.js";
import { t } from "./i18n/index.js";
import type { PermissionMode } from "./permissions.js";

/** A screen stub carrying the two bits `askPlanApproval` reads and writes. */
function fakeScreen(mode: PermissionMode, before: PermissionMode | null): PlanApprovalScreen {
  let current = mode;
  return {
    getPermissionMode: () => current,
    getModeBeforePlan: () => before,
    setPermissionMode: (m) => {
      current = m;
    },
  };
}

function answering(res: AskUserResponse): AskUserFn {
  return async () => res;
}

describe("askPlanApproval", () => {
  it("restores the mode the user was in before plan mode", async () => {
    const screen = fakeScreen("plan", "auto");
    const out = await askPlanApproval(
      answering({ answers: [{ selected: [t.planMode.approve] }] }),
      screen,
    );
    expect(out).toEqual({ approved: true });
    expect(screen.getPermissionMode()).toBe("auto");
  });

  it("falls back to default when there is no recorded mode", async () => {
    const screen = fakeScreen("plan", null);
    await askPlanApproval(answering({ answers: [{ selected: [t.planMode.approve] }] }), screen);
    expect(screen.getPermissionMode()).toBe("default");
  });

  it("keeps plan mode on when the user declines, and returns their feedback", async () => {
    const screen = fakeScreen("plan", "auto");
    const out = await askPlanApproval(
      answering({ answers: [{ selected: ["Other"], freeform: "先只改 config" }] }),
      screen,
    );
    expect(out).toEqual({ approved: false, feedback: "先只改 config" });
    expect(screen.getPermissionMode()).toBe("plan");
  });

  it("treats a dismissed prompt as a decline, not consent", async () => {
    const screen = fakeScreen("plan", "auto");
    const out = await askPlanApproval(answering({ answers: [], cancelled: true }), screen);
    expect(out).toEqual({ approved: false, cancelled: true });
    expect(screen.getPermissionMode()).toBe("plan");
  });
});

describe("shouldGatePlanApproval", () => {
  const armed = {
    enabled: true,
    mode: "plan" as PermissionMode,
    armed: true,
    askedThisTurn: false,
    busy: false,
  };

  it("fires once a turn ends with plan mode still on", () => {
    expect(shouldGatePlanApproval(armed)).toBe(true);
  });

  it("stays quiet when the setting is off", () => {
    expect(shouldGatePlanApproval({ ...armed, enabled: false })).toBe(false);
  });

  it("stays quiet outside plan mode", () => {
    // The usual approved path: exitPlanMode already flipped the mode, so the
    // gate must not ask a second time.
    expect(shouldGatePlanApproval({ ...armed, mode: "auto" })).toBe(false);
  });

  it("stays quiet until a turn has actually completed", () => {
    // e.g. the user hit shift+tab into plan mode and has not prompted yet.
    expect(shouldGatePlanApproval({ ...armed, armed: false })).toBe(false);
  });

  it("stays quiet when exitPlanMode already asked during that turn", () => {
    // The rejection case: the tool asked, the user said no, plan mode is still
    // on — re-asking immediately would be the same question twice in a row.
    expect(shouldGatePlanApproval({ ...armed, askedThisTurn: true })).toBe(false);
  });

  it("stays quiet while a turn is in flight", () => {
    expect(shouldGatePlanApproval({ ...armed, busy: true })).toBe(false);
  });
});

describe("PLAN_APPROVED_PROMPT", () => {
  it("carries the approval without repeating the plan", () => {
    expect(PLAN_APPROVED_PROMPT).toContain("approved");
    expect(PLAN_APPROVED_PROMPT).toContain("Plan mode is OFF");
    // Short by construction: the plan is already in the history being sent.
    expect(PLAN_APPROVED_PROMPT.length).toBeLessThan(400);
  });
});
