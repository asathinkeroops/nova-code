import { describe, expect, it } from "vitest";
import { createLoadSkillTool } from "./load-skill.js";

describe("createLoadSkillTool", () => {
  it("returns an isError result for unknown skill names", async () => {
    const tool = createLoadSkillTool(() => undefined);
    const result = await tool.run({ name: "missing" }, { cwd: "/" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unknown skill: missing");
    expect(result.output).toContain("/skills");
  });

  it("wraps body in a <skill> tag for known skills", async () => {
    const tool = createLoadSkillTool(({ name }) =>
      name === "code-reviewer" ? "do the thing" : undefined,
    );
    const result = await tool.run({ name: "code-reviewer" }, { cwd: "/" });
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe(
      `<skill name="code-reviewer">\ndo the thing\n</skill>`,
    );
  });

  it("truncates and appends a hint when body exceeds maxResponseBytes", async () => {
    const big = "x".repeat(10_000);
    const tool = createLoadSkillTool(() => big, { maxResponseBytes: 100 });
    const result = await tool.run({ name: "huge" }, { cwd: "/" });
    expect(result.output).toContain("…(truncated.");
    expect(result.output).toContain("settings.skills.maxResponseBytes");
    // Body inside the tag should be capped to 100 chars + newline + hint.
    expect(result.output.length).toBeLessThan(500);
  });

  it("sees fresh values when the injected getSkill function returns new data", async () => {
    let stored = "first";
    const tool = createLoadSkillTool(() => stored);
    const a = await tool.run({ name: "x" }, { cwd: "/" });
    expect(a.output).toContain("first");
    stored = "second";
    const b = await tool.run({ name: "x" }, { cwd: "/" });
    expect(b.output).toContain("second");
  });

  it("returns isError when input fails schema validation", async () => {
    const tool = createLoadSkillTool(() => "body");
    await expect(tool.run({ name: "" }, { cwd: "/" })).rejects.toThrow();
  });
});
