import { describe, expect, it } from "vitest";
import type { ToolHandler } from "@nova/core";
import {
  createPlanModeTools,
  ENTER_PLAN_MODE_TOOL,
  EXIT_PLAN_MODE_TOOL,
  PLAN_MODE_TOOL_NAMES,
  type PlanExitDecision,
} from "./plan-mode.js";

/**
 * A stand-in host: `active` is the permission mode, and `requestExit` plays the
 * user. Like the real CLI bridge, it is the HOST that turns plan mode off on
 * approval — the tool must never do that itself.
 */
function harness(opts: { active?: boolean; answer?: PlanExitDecision } = {}) {
  const state = {
    active: opts.active ?? false,
    exitCalls: [] as string[],
    entered: 0,
  };
  const tools = createPlanModeTools({
    isActive: () => state.active,
    enter: () => {
      state.entered++;
      state.active = true;
    },
    requestExit: async (plan) => {
      state.exitCalls.push(plan);
      const answer = opts.answer ?? { approved: true };
      if (answer.approved) state.active = false;
      return answer;
    },
  });
  const byName = (name: string): ToolHandler => {
    const tool = tools.find((h) => h.definition.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool;
  };
  return { state, enter: byName(ENTER_PLAN_MODE_TOOL), exit: byName(EXIT_PLAN_MODE_TOOL) };
}

const ctx = { cwd: "/tmp" };

describe("createPlanModeTools", () => {
  it("registers exactly the two advertised names", () => {
    const names = createPlanModeTools({
      isActive: () => false,
      enter: () => {},
      requestExit: async () => ({ approved: false }),
    }).map((t) => t.definition.name);
    expect(names).toEqual([ENTER_PLAN_MODE_TOOL, EXIT_PLAN_MODE_TOOL]);
    expect([...PLAN_MODE_TOOL_NAMES].sort()).toEqual([...names].sort());
  });
});

describe("enterPlanMode", () => {
  it("turns plan mode on and tells the model what is now denied", async () => {
    const h = harness();
    const res = await h.enter.run({}, ctx);
    expect(h.state.active).toBe(true);
    expect(h.state.entered).toBe(1);
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("Plan mode is ON");
  });

  it("is idempotent: a second call does not re-enter", async () => {
    const h = harness({ active: true });
    const res = await h.enter.run({}, ctx);
    expect(h.state.entered).toBe(0);
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("already on");
  });
});

describe("exitPlanMode", () => {
  it("errors instead of prompting when plan mode is off", async () => {
    const h = harness({ active: false });
    const res = await h.exit.run({ plan: "1. do the thing" }, ctx);
    expect(res.isError).toBe(true);
    expect(h.state.exitCalls).toEqual([]);
  });

  it("passes the plan to the host and reports approval", async () => {
    const h = harness({ active: true, answer: { approved: true } });
    const res = await h.exit.run({ plan: "1. edit foo.ts\n2. run tests" }, ctx);
    expect(h.state.exitCalls).toEqual(["1. edit foo.ts\n2. run tests"]);
    expect(h.state.active).toBe(false);
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("approved");
  });

  it("keeps plan mode on and relays feedback when the user declines", async () => {
    const h = harness({
      active: true,
      answer: { approved: false, feedback: "  split step 2  " },
    });
    const res = await h.exit.run({ plan: "1. rewrite everything" }, ctx);
    expect(h.state.active).toBe(true);
    // A decline is not a tool failure — the model should revise, not retry-error.
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("did NOT approve");
    expect(res.output).toContain("split step 2");
  });

  it("tells the model to wait when the user declines without feedback", async () => {
    const h = harness({ active: true, answer: { approved: false } });
    const res = await h.exit.run({ plan: "1. rewrite everything" }, ctx);
    expect(h.state.active).toBe(true);
    // Not an error — the user answered, they just did not say what to change.
    // The host ends the turn; this text is what the model reads next time.
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("did NOT approve");
    expect(res.output).toContain("wait for their next message");
    expect(res.output).not.toContain("Revise the plan accordingly");
  });

  it("treats whitespace-only feedback as no feedback", async () => {
    const h = harness({ active: true, answer: { approved: false, feedback: "   " } });
    const res = await h.exit.run({ plan: "1. ship it" }, ctx);
    expect(res.output).toContain("wait for their next message");
  });

  it("errors on a cancelled prompt so the model waits instead of retrying", async () => {
    const h = harness({ active: true, answer: { approved: false, cancelled: true } });
    const res = await h.exit.run({ plan: "1. ship it" }, ctx);
    expect(h.state.active).toBe(true);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("do not retry this tool");
    expect(res.output).toContain("wait for the user's next message");
  });

  it("rejects an empty or whitespace-only plan before asking the user", async () => {
    // Whitespace matters: it renders as nothing, so letting it through would
    // ask the user to approve a plan they cannot see.
    for (const plan of ["", "   ", "\n\t"]) {
      const h = harness({ active: true });
      await expect(h.exit.run({ plan }, ctx)).rejects.toThrow();
      expect(h.state.exitCalls).toEqual([]);
    }
  });

  it("hands the host a trimmed plan", async () => {
    const h = harness({ active: true });
    await h.exit.run({ plan: "\n  # 方案\n  " }, ctx);
    expect(h.state.exitCalls).toEqual(["# 方案"]);
  });
});

describe("plan-mode input schemas", () => {
  it("lets enterPlanMode tolerate a stray key rather than failing the call", () => {
    const schema = harness().enter.definition.inputSchema;
    // The tool takes nothing, so an extra key is noise, not a misread argument.
    for (const input of [{}, { reason: "user asked for a plan" }, { input: {} }]) {
      const parsed = schema.safeParse(input);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data).toEqual({});
    }
  });

  it("keeps exitPlanMode strict — an unknown key there means a misread argument", () => {
    const schema = harness().exit.definition.inputSchema;
    expect(schema.safeParse({ plan: "x", extra: 1 }).success).toBe(false);
    expect(schema.safeParse({ Plan: "x" }).success).toBe(false);
  });
});
