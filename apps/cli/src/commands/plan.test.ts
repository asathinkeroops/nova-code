import { describe, expect, it } from "vitest";
import { handlePlan } from "./plan.js";

describe("handlePlan", () => {
  it("returns a prompt that delegates to a plan sub-agent and carries the goal", () => {
    const outcome = handlePlan("add OAuth login");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain('createSubAgent (type: "plan")');
    expect(outcome.text).toContain("add OAuth login");
    expect(outcome.text).toMatch(/do NOT start implement/i);
  });

  it("trims surrounding whitespace from the goal", () => {
    const outcome = handlePlan("   refactor parser   ");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("Task goal:\nrefactor parser");
  });

  it.each(["", "   ", "\n\t "])("errors with usage on empty/blank arg %p", (arg) => {
    const outcome = handlePlan(arg);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toMatch(/usage: \/plan/);
  });
});
