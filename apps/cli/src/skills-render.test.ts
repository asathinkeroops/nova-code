import { describe, expect, it } from "vitest";
import type { SkillListItem } from "@nova/tools";
import { renderSkillsBlock } from "./skills-render.js";

const item = (name: string, description: string): SkillListItem => ({
  name,
  description,
  triggers: [],
  location: `/tmp/skills/${name}`,
});

describe("renderSkillsBlock", () => {
  it("returns empty string for an empty list", () => {
    expect(renderSkillsBlock([], 8192)).toBe("");
  });

  it("renders a single skill inside the tag with hint footer", () => {
    const out = renderSkillsBlock([item("x", "do x")], 8192);
    expect(out).toContain("<available-skills>");
    expect(out).toContain("- x: do x");
    expect(out).toContain("Use the `loadSkill` tool");
    expect(out).toContain("</available-skills>");
  });

  it("sorts by name alphabetically (cache-stable)", () => {
    const out = renderSkillsBlock(
      [item("z", "z"), item("a", "a"), item("m", "m")],
      8192,
    );
    const lines = out.split("\n");
    const skillLines = lines.filter((l) => l.startsWith("- "));
    expect(skillLines).toEqual(["- a: a", "- m: m", "- z: z"]);
  });

  it("truncates at maxBytes and appends a truncation hint with the leftover count", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item(`skill${String(i).padStart(2, "0")}`, "x".repeat(40)),
    );
    const out = renderSkillsBlock(items, 200);
    expect(out).toContain("more skills truncated");
    expect(out).toContain("settings.skills.maxIndexBytes");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(400);
  });

  it("identical input yields identical output across calls", () => {
    const items = [item("b", "B"), item("a", "A"), item("c", "C")];
    expect(renderSkillsBlock(items, 8192)).toBe(renderSkillsBlock(items, 8192));
  });
});
