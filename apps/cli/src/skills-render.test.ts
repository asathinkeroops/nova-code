import { describe, expect, it } from "vitest";
import type { SkillListItem } from "@nova/tools";
import { renderSkillsBlock, renderSkillsMessage } from "./skills-render.js";

const item = (name: string, description: string): SkillListItem => ({
  name,
  description,
  disableModelInvocation: false,
  userInvocable: true,
  location: `/tmp/skills/${name}`,
});

const opts = (budgetBytes: number, maxDescriptionBytes = 1536) => ({
  budgetBytes,
  maxDescriptionBytes,
});

function skillLines(out: string): string[] {
  return out.split("\n").filter((l) => l.startsWith("- "));
}

describe("renderSkillsBlock", () => {
  it("returns empty string for an empty list", () => {
    expect(renderSkillsBlock([], opts(8192))).toBe("");
  });

  it("renders a single skill inside the tag with hint footer", () => {
    const out = renderSkillsBlock([item("x", "do x")], opts(8192));
    expect(out).toContain("<available-skills>");
    expect(out).toContain("- x: do x");
    expect(out).toContain("Use the `loadSkill` tool");
    expect(out).toContain("</available-skills>");
  });

  it("sorts by name alphabetically (cache-stable)", () => {
    const out = renderSkillsBlock([item("z", "z"), item("a", "a"), item("m", "m")], opts(8192));
    expect(skillLines(out)).toEqual(["- a: a", "- m: m", "- z: z"]);
  });

  it("identical input yields identical output across calls", () => {
    const items = [item("b", "B"), item("a", "A"), item("c", "C")];
    expect(renderSkillsBlock(items, opts(8192))).toBe(renderSkillsBlock(items, opts(8192)));
  });
});

describe("renderSkillsMessage", () => {
  it("renders the first-injection form without the system-prompt footer", () => {
    const msg = renderSkillsMessage([item("x", "do x")], opts(8192));
    expect(msg.text).toBe("<available-skills>\n- x: do x\n</available-skills>");
    expect(msg.text).not.toContain("Use the `loadSkill` tool");
  });

  it("renders the changed form with a marker line", () => {
    const msg = renderSkillsMessage([item("x", "do x")], opts(8192));
    expect(msg.changedText).toBe(
      "<available-skills>\nskills has changed\n- x: do x\n</available-skills>",
    );
  });

  it("renders the empty-list form in both variants", () => {
    const msg = renderSkillsMessage([], opts(8192));
    expect(msg.text).toBe(
      "<available-skills>\nno skills are currently available\n</available-skills>",
    );
    expect(msg.changedText).toContain("skills has changed");
    expect(msg.version).toBe("empty");
  });

  it("versions the list payload, not the changed marker", () => {
    const a = renderSkillsMessage([item("x", "do x")], opts(8192));
    const b = renderSkillsMessage([item("x", "do x")], opts(8192));
    const c = renderSkillsMessage([item("x", "do y")], opts(8192));
    expect(a.version).toBe(b.version);
    expect(c.version).not.toBe(a.version);
  });

  it("is order-independent (prefix-cache stability)", () => {
    const a = renderSkillsMessage([item("b", "B"), item("a", "A")], opts(8192));
    const b = renderSkillsMessage([item("a", "A"), item("b", "B")], opts(8192));
    expect(a).toEqual(b);
  });

  it("still degrades entries to name-only under budget pressure", () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`skill${i}`, "x".repeat(40)));
    const msg = renderSkillsMessage(items, opts(1));
    expect(skillLines(msg.text)).toHaveLength(20);
  });
});

describe("renderSkillsBlock — per-entry description cap", () => {
  it("caps an over-long description and marks the cut", () => {
    const out = renderSkillsBlock([item("x", "d".repeat(500))], opts(8192, 100));
    const line = skillLines(out)[0] as string;
    expect(line.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(line.slice("- x: ".length), "utf8")).toBeLessThanOrEqual(100);
  });

  it("leaves a description under the cap untouched", () => {
    const out = renderSkillsBlock([item("x", "short")], opts(8192, 100));
    expect(skillLines(out)).toEqual(["- x: short"]);
  });

  it("never splits a multi-byte character when capping", () => {
    // Each CJK char is 3 utf8 bytes; a cap of 20 lands mid-character.
    const out = renderSkillsBlock([item("x", "中".repeat(50))], opts(8192, 20));
    const desc = (skillLines(out)[0] as string).slice("- x: ".length);
    expect(desc).not.toContain("�");
    expect(Buffer.byteLength(desc, "utf8")).toBeLessThanOrEqual(20);
  });
});

describe("renderSkillsBlock — budget overflow", () => {
  const many = () =>
    Array.from({ length: 20 }, (_, i) =>
      item(`skill${String(i).padStart(2, "0")}`, "x".repeat(40)),
    );

  it("degrades entries to name-only instead of dropping skills", () => {
    const out = renderSkillsBlock(many(), opts(300));
    const lines = skillLines(out);
    // Every skill is still listed — a skill the model cannot name is unusable,
    // whereas a name-only entry is still invocable via loadSkill.
    expect(lines).toHaveLength(20);
    expect(lines.filter((l) => l.includes(": "))).not.toHaveLength(20);
    expect(lines.some((l) => l === "- skill00")).toBe(true);
  });

  it("keeps every skill even when the budget cannot fit the names alone", () => {
    expect(skillLines(renderSkillsBlock(many(), opts(1)))).toHaveLength(20);
  });

  it("keeps all descriptions when the listing fits", () => {
    const out = renderSkillsBlock(many(), opts(8192));
    expect(skillLines(out).every((l) => l.includes(": "))).toBe(true);
  });

  it("spends the budget cheapest-first so more skills keep a description", () => {
    const items = [
      item("a", "x".repeat(200)),
      item("b", "short"),
      item("c", "tiny"),
      item("d", "x".repeat(200)),
    ];
    const lines = skillLines(renderSkillsBlock(items, opts(260)));
    // The two cheap entries fit; the two expensive ones fall back to name-only.
    expect(lines).toEqual(["- a", "- b: short", "- c: tiny", "- d"]);
  });

  it("is deterministic under overflow (prefix-cache stability)", () => {
    const items = many();
    expect(renderSkillsBlock(items, opts(300))).toBe(renderSkillsBlock(items, opts(300)));
  });

  it("no longer references the removed maxIndexBytes truncation hint", () => {
    const out = renderSkillsBlock(many(), opts(300));
    expect(out).not.toContain("more skills truncated");
  });
});
