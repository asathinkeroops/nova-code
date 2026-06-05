import { describe, expect, it } from "vitest";
import { handleInit } from "./init.js";

describe("handleInit", () => {
  it("returns a prompt that writes NOVA.md and explores the repo", () => {
    const outcome = handleInit("");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("NOVA.md");
    expect(outcome.text).toMatch(/Write tool/);
    expect(outcome.text).toMatch(/explore the repository/i);
  });

  it("tells the agent to improve an existing memory file instead of overwriting", () => {
    const outcome = handleInit("");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("CLAUDE.md");
    expect(outcome.text).toContain("AGENTS.md");
    expect(outcome.text).toMatch(/IMPROVE/);
  });

  it("weaves a focus arg into the prompt", () => {
    const outcome = handleInit("  the build pipeline  ");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("the build pipeline");
  });

  it("omits the focus line when no arg is given", () => {
    const outcome = handleInit("   ");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).not.toMatch(/pay particular attention/);
  });
});
