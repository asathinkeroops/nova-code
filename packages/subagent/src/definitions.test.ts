import { describe, expect, it } from "vitest";
import { AgentRegistry, BUILTIN_AGENTS, type AgentDefinition } from "./definitions.js";

function custom(name: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    description: `${name} desc`,
    roleLine: `${name} role`,
    guidance: "",
    readOnly: false,
    source: "project",
    ...over,
  };
}

describe("AgentRegistry", () => {
  it("seeds the three built-ins by default", () => {
    const r = new AgentRegistry();
    expect(r.names().sort()).toEqual(["explore", "general-purpose", "plan"]);
    expect(BUILTIN_AGENTS).toHaveLength(3);
  });

  it("adds custom defs and reports built-in collisions as skipped", () => {
    const r = new AgentRegistry();
    const skipped = r.addCustom([custom("reviewer"), custom("plan"), custom("general-purpose")]);

    expect(skipped.sort()).toEqual(["general-purpose", "plan"]);
    expect(r.get("reviewer")?.description).toBe("reviewer desc");
    // built-in is untouched
    expect(r.get("plan")?.source).toBe("builtin");
  });

  it("first custom wins on same-name collisions between customs", () => {
    const r = new AgentRegistry();
    const skipped = r.addCustom([
      custom("dup", { description: "first" }),
      custom("dup", { description: "second" }),
    ]);

    expect(skipped).toEqual(["dup"]);
    expect(r.get("dup")?.description).toBe("first");
  });

  it("replaceCustom resets to built-ins then re-layers", () => {
    const r = new AgentRegistry();
    r.addCustom([custom("old")]);
    expect(r.get("old")).toBeDefined();

    r.replaceCustom([custom("new")]);
    expect(r.get("old")).toBeUndefined();
    expect(r.get("new")).toBeDefined();
    // built-ins survive a replace
    expect(r.get("general-purpose")).toBeDefined();
  });
});
