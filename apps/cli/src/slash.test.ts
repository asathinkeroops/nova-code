import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashRegistry } from "./slash-registry.js";
import { settingsSchema, type Logger, type Settings } from "@nova/base";
import { describe, expect, it } from "vitest";
import { loadSkillCommandsInto } from "./slash.js";

const logger = {
  warn() {},
  info() {},
  error() {},
  debug() {},
} as unknown as Logger;

function settings(): Settings {
  // Empty `userPaths` pins the scan to the temp workspace. Left at its default
  // the loader also walks the real `~/.nova/skills`, so `added` counts whatever
  // the developer happens to have installed and the assertions drift.
  return settingsSchema.parse({ skills: { userPaths: [] } });
}

function workspaceWithSkill(name: string, description = "a skill", body = "Do the thing."): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-slash-skill-"));
  const skillDir = join(dir, ".nova", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf8",
  );
  return dir;
}

/** Invoke a registered slash command and return its prompt text. */
async function invoke(registry: SlashRegistry, cwd: string, line: string): Promise<string> {
  const hit = registry.resolve(line);
  expect(hit).not.toBeNull();
  const outcome = await (hit as NonNullable<typeof hit>).cmd.run({ cwd }, hit!.args);
  expect(outcome).toMatchObject({ kind: "prompt" });
  return (outcome as { kind: "prompt"; text: string }).text;
}

describe("loadSkillCommandsInto", () => {
  it("inlines the SKILL.md body rather than telling the model to call loadSkill", async () => {
    const cwd = workspaceWithSkill("say-hello");
    const registry = new SlashRegistry();

    const { added } = loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });
    expect(added).toBe(1);
    expect(registry.resolve("/say-hello")?.cmd.source.kind).toBe("skill");

    const text = await invoke(registry, cwd, "/say-hello Alice");
    // One hop: the body itself is injected, wrapped in the same envelope the
    // loadSkill tool returns, so the model sees identical text either way.
    expect(text).toContain('<skill name="say-hello"');
    expect(text).toContain("Do the thing.");
    expect(text).not.toContain("call the `loadSkill` tool");
  });

  it("binds typed arguments into the body", async () => {
    const cwd = workspaceWithSkill("greet", "a skill", "Greet $1 warmly. All args: $ARGUMENTS");
    const registry = new SlashRegistry();
    loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });

    const text = await invoke(registry, cwd, "/greet Alice Bob");
    expect(text).toContain("Greet Alice warmly.");
    expect(text).toContain("All args: Alice Bob");
  });

  it("carries the typed request into a body that declares no placeholder", async () => {
    // The common SKILL.md shape: standing instructions, no `$ARGUMENTS`. Without
    // the fallback the model received the manual and none of the request, and
    // answered `/report last week's numbers` by asking what to report.
    const cwd = workspaceWithSkill("report", "a skill", "Query the warehouse and answer.");
    const registry = new SlashRegistry();
    loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });

    const text = await invoke(registry, cwd, "/report last week's numbers");
    expect(text).toContain("ARGUMENTS: last week's numbers");
  });

  it("appends only what the body's placeholders left over", async () => {
    const cwd = workspaceWithSkill("greet", "a skill", "Greet $1.");
    const registry = new SlashRegistry();
    loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });

    const text = await invoke(registry, cwd, "/greet Alice Bob");
    expect(text).toContain("Greet Alice.");
    expect(text).toContain("ARGUMENTS: Bob");
  });

  it("does not append when the body consumed everything", async () => {
    const cwd = workspaceWithSkill("greet", "a skill", "Greet $ARGUMENTS.");
    const registry = new SlashRegistry();
    loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });

    expect(await invoke(registry, cwd, "/greet Alice Bob")).not.toContain("ARGUMENTS:");
  });

  it("blanks argument placeholders when invoked with no args", async () => {
    const cwd = workspaceWithSkill("greet", "a skill", "Greet [$1] done");
    const registry = new SlashRegistry();
    loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });

    expect(await invoke(registry, cwd, "/greet")).toContain("Greet [] done");
  });

  it("expands the skill-dir variable in the inlined body", async () => {
    const cwd = workspaceWithSkill("scripted", "a skill", "run ${CLAUDE_SKILL_DIR}/go.sh");
    const registry = new SlashRegistry();
    loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });

    const text = await invoke(registry, cwd, "/scripted");
    expect(text).toContain(`run ${join(cwd, ".nova", "skills", "scripted")}/go.sh`);
    expect(text).not.toContain("${CLAUDE_SKILL_DIR}");
  });

  it("rereads the body on each invocation so edits land without a reload", async () => {
    const cwd = workspaceWithSkill("edit-me", "a skill", "FIRST");
    const registry = new SlashRegistry();
    loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });
    expect(await invoke(registry, cwd, "/edit-me")).toContain("FIRST");

    writeFileSync(
      join(cwd, ".nova", "skills", "edit-me", "SKILL.md"),
      `---\nname: edit-me\ndescription: a skill\n---\nSECOND\n`,
      "utf8",
    );
    expect(await invoke(registry, cwd, "/edit-me")).toContain("SECOND");
  });

  it("errors instead of injecting a stale body when the file becomes unreadable", async () => {
    const cwd = workspaceWithSkill("vanishing");
    const registry = new SlashRegistry();
    loadSkillCommandsInto(registry, { cwd, settings: settings(), logger });

    rmSync(join(cwd, ".nova", "skills", "vanishing", "SKILL.md"));
    const hit = registry.resolve("/vanishing");
    const outcome = await hit!.cmd.run({ cwd }, hit!.args);
    expect(outcome.kind).toBe("error");
    expect((outcome as { kind: "error"; message: string }).message).toContain("/commands reload");
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

  it("skips skills flagged user-invocable: false", () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-slash-skill-"));
    const skillDir = join(dir, ".nova", "skills", "model-only");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: model-only\ndescription: a skill\nuser-invocable: false\n---\nDo the thing.\n`,
      "utf8",
    );
    const registry = new SlashRegistry();

    const { added } = loadSkillCommandsInto(registry, { cwd: dir, settings: settings(), logger });
    expect(added).toBe(0);
    expect(registry.resolve("/model-only")).toBeNull();
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
