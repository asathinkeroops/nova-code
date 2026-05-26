import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSkill, getSkillList, _resetSkillsCacheForTests } from "./skills.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "nova-skills-"));
}

function writeSkill(root: string, name: string, fm: string, body = "BODY"): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}\n`, "utf8");
}

beforeEach(() => {
  _resetSkillsCacheForTests();
});

afterEach(() => {
  _resetSkillsCacheForTests();
});

describe("getSkillList — parsing", () => {
  it("returns a populated list for a well-formed SKILL.md", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(
      projectRoot,
      "code-reviewer",
      `name: code-reviewer\ndescription: Review a diff\ntriggers:\n  - review\n  - diff`,
    );
    const list = getSkillList({ cwd, home: cwd, userPaths: [] });
    expect(list).toEqual([
      { name: "code-reviewer", description: "Review a diff", triggers: ["review", "diff"] },
    ]);
  });

  it("supports flow-style triggers arrays", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x\ndescription: d\ntriggers: [a, b]`);
    expect(getSkillList({ cwd, home: cwd, userPaths: [] })[0]?.triggers).toEqual(["a", "b"]);
  });

  it("defaults triggers to [] when absent", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x\ndescription: d`);
    expect(getSkillList({ cwd, home: cwd, userPaths: [] })[0]?.triggers).toEqual([]);
  });

  it("drops skills with missing name and logs warn", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `description: d`);
    const logger = { warn: vi.fn() };
    const list = getSkillList({ cwd, home: cwd, userPaths: [], logger });
    expect(list).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("drops skills with missing description and logs warn", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x`);
    const logger = { warn: vi.fn() };
    expect(getSkillList({ cwd, home: cwd, userPaths: [], logger })).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("drops skills with invalid name (uppercase) and logs warn", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: BadName\ndescription: d`);
    const logger = { warn: vi.fn() };
    expect(getSkillList({ cwd, home: cwd, userPaths: [], logger })).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("truncates description over 200 chars but keeps the skill", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    const longDesc = "x".repeat(250);
    writeSkill(projectRoot, "x", `name: x\ndescription: ${longDesc}`);
    const item = getSkillList({ cwd, home: cwd, userPaths: [] })[0];
    expect(item?.description.length).toBe(200);
  });
});

describe("getSkillList — scanning", () => {
  it("collects from both project and user roots", () => {
    const cwd = fixture();
    const home = fixture();
    mkdirSync(join(cwd, ".nova/skills"), { recursive: true });
    mkdirSync(join(home, ".nova/skills"), { recursive: true });
    writeSkill(join(cwd, ".nova/skills"), "p", `name: p\ndescription: d`);
    writeSkill(join(home, ".nova/skills"), "u", `name: u\ndescription: d`);
    const names = getSkillList({ cwd, home }).map((s) => s.name).sort();
    expect(names).toEqual(["p", "u"]);
  });

  it("project wins on name collision", () => {
    const cwd = fixture();
    const home = fixture();
    mkdirSync(join(cwd, ".nova/skills"), { recursive: true });
    mkdirSync(join(home, ".nova/skills"), { recursive: true });
    writeSkill(join(cwd, ".nova/skills"), "same", `name: same\ndescription: project`);
    writeSkill(join(home, ".nova/skills"), "same", `name: same\ndescription: user`);
    const item = getSkillList({ cwd, home })[0];
    expect(item?.description).toBe("project");
  });

  it("first project root wins among multiple", () => {
    const cwd = fixture();
    mkdirSync(join(cwd, ".nova/skills"), { recursive: true });
    mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
    writeSkill(join(cwd, ".nova/skills"), "x", `name: x\ndescription: nova`);
    writeSkill(join(cwd, ".claude/skills"), "x", `name: x\ndescription: claude`);
    const item = getSkillList({ cwd, home: cwd, userPaths: [] })[0];
    expect(item?.description).toBe("nova");
  });

  it("does not recurse into nested subdirectories", () => {
    const cwd = fixture();
    const nested = join(cwd, ".nova/skills/foo/bar");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "SKILL.md"), `---\nname: x\ndescription: d\n---\nbody`);
    expect(getSkillList({ cwd, home: cwd, userPaths: [] })).toEqual([]);
  });

  it("skips subdirectories without a SKILL.md silently", () => {
    const cwd = fixture();
    const empty = join(cwd, ".nova/skills/empty");
    mkdirSync(empty, { recursive: true });
    const logger = { warn: vi.fn() };
    expect(getSkillList({ cwd, home: cwd, userPaths: [], logger })).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("getSkill", () => {
  it("returns the body for a known name", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x\ndescription: d`, "  hello body  ");
    const body = getSkill({ name: "x" }, { cwd, home: cwd, userPaths: [] });
    expect(body?.startsWith("hello body")).toBe(true);
  });

  it("returns undefined for unknown name", () => {
    const cwd = fixture();
    expect(getSkill({ name: "missing" }, { cwd, home: cwd, userPaths: [] })).toBeUndefined();
  });

  it("returns the project body when project shadows user", () => {
    const cwd = fixture();
    const home = fixture();
    mkdirSync(join(cwd, ".nova/skills"), { recursive: true });
    mkdirSync(join(home, ".nova/skills"), { recursive: true });
    writeSkill(join(cwd, ".nova/skills"), "same", `name: same\ndescription: d`, "PROJECT");
    writeSkill(join(home, ".nova/skills"), "same", `name: same\ndescription: d`, "USER");
    expect(getSkill({ name: "same" }, { cwd, home })?.includes("PROJECT")).toBe(true);
  });
});

describe("memoization", () => {
  it("does not re-read fs on identical opts", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x\ndescription: d`);

    // First call warms the cache.
    getSkillList({ cwd, home: cwd, userPaths: [] });

    // Mutating the file on disk should not affect a second call (proves cache).
    writeFileSync(
      join(projectRoot, "x/SKILL.md"),
      `---\nname: x\ndescription: CHANGED\n---\nbody\n`,
    );
    const second = getSkillList({ cwd, home: cwd, userPaths: [] });
    expect(second[0]?.description).toBe("d");
  });

  it("re-scans when extraDirs changes the cache key", () => {
    const cwd = fixture();
    mkdirSync(join(cwd, ".nova/skills"), { recursive: true });
    writeSkill(join(cwd, ".nova/skills"), "x", `name: x\ndescription: d`);
    const first = getSkillList({ cwd, home: cwd, userPaths: [] });
    expect(first.length).toBe(1);

    const extra = fixture();
    mkdirSync(extra, { recursive: true });
    writeSkill(extra, "y", `name: y\ndescription: d`);
    const second = getSkillList({
      cwd,
      home: cwd,
      userPaths: [],
      extraDirs: [extra],
    });
    expect(second.map((s) => s.name).sort()).toEqual(["x", "y"]);
  });
});

// Sanity: fs APIs in the implementation are sync; this just confirms we
// didn't accidentally regress to async + forgot to await.
it("returns synchronously without throwing on empty cwd", () => {
  const cwd = fixture();
  expect(statSync(cwd).isDirectory()).toBe(true);
  expect(getSkillList({ cwd, home: cwd, userPaths: [] })).toEqual([]);
});
