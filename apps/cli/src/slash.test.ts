import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashRegistry } from "@nova/external";
import { settingsSchema, type Logger, type Settings } from "@nova/runtime";
import { describe, expect, it } from "vitest";
import { loadSkillCommandsInto } from "./slash.js";

const logger = {
  warn() {},
  info() {},
  error() {},
  debug() {},
} as unknown as Logger;

function settings(): Settings {
  return settingsSchema.parse({});
}

function workspaceWithSkill(name: string, description = "a skill"): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-slash-skill-"));
  const skillDir = join(dir, ".nova", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nDo the thing.\n`,
    "utf8",
  );
  return dir;
}

describe("loadSkillCommandsInto", () => {
  it("registers each skill as a slash command that emits a prompt with args", () => {
    const cwd = workspaceWithSkill("say-hello");
    const registry = new SlashRegistry();

    const { added } = loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });
    expect(added).toBe(1);

    const hit = registry.resolve("/say-hello Alice");
    expect(hit).not.toBeNull();
    expect(hit?.cmd.source.kind).toBe("skill");
    const outcome = hit?.cmd.run({ cwd }, hit.args);
    expect(outcome).toMatchObject({ kind: "prompt" });
    const text = (outcome as { kind: "prompt"; text: string }).text;
    expect(text).toContain('loadSkill');
    expect(text).toContain("say-hello");
    expect(text).toContain("Arguments: Alice");
  });

  it("omits the Arguments line when invoked with no args", () => {
    const cwd = workspaceWithSkill("say-hello");
    const registry = new SlashRegistry();
    loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });

    const hit = registry.resolve("/say-hello");
    const outcome = hit?.cmd.run({ cwd }, hit.args) as { kind: "prompt"; text: string };
    expect(outcome.text).not.toContain("Arguments:");
  });

  it("lets an existing builtin shadow a same-named skill", () => {
    const cwd = workspaceWithSkill("say-hello");
    const registry = new SlashRegistry();
    registry.register({
      name: "say-hello",
      description: "builtin wins",
      source: { kind: "builtin" },
      run: () => ({ kind: "handled" }),
    });

    const { added } = loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });
    expect(added).toBe(0);

    const hit = registry.resolve("/say-hello");
    expect(hit?.cmd.source.kind).toBe("builtin");
    // The shadowed skill is recorded on the winner for /commands diagnostics.
    expect(hit?.cmd.source.shadowedBy).toContainEqual({
      kind: "skill",
      path: join(cwd, ".nova", "skills", "say-hello"),
    });
  });

  it("registers nothing when skills are disabled", () => {
    const cwd = workspaceWithSkill("say-hello");
    const registry = new SlashRegistry();
    const disabled = settings();
    disabled.skills.enabled = false;

    const { added } = loadSkillCommandsInto(registry, { cwd, settings: disabled, logger });
    expect(added).toBe(0);
    expect(registry.resolve("/say-hello")).toBeNull();
  });
});
