import { mkdtempSync, mkdirSync, writeFileSync, statSync, symlinkSync } from "node:fs";
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
      `name: code-reviewer\ndescription: Review a diff`,
    );
    const list = getSkillList({ cwd, home: cwd, userPaths: [] });
    expect(list).toEqual([
      {
        name: "code-reviewer",
        description: "Review a diff",
        disableModelInvocation: false,
        userInvocable: true,
        location: join(projectRoot, "code-reviewer"),
      },
    ]);
  });

  it("parses disable-model-invocation and user-invocable flags", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(
      projectRoot,
      "x",
      `name: x\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false`,
    );
    const item = getSkillList({ cwd, home: cwd, userPaths: [] })[0];
    expect(item?.disableModelInvocation).toBe(true);
    expect(item?.userInvocable).toBe(false);
  });

  it("defaults the invocation flags (model-visible, user-invocable) when absent", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x\ndescription: d`);
    const item = getSkillList({ cwd, home: cwd, userPaths: [] })[0];
    expect(item?.disableModelInvocation).toBe(false);
    expect(item?.userInvocable).toBe(true);
  });

  it("falls back to defaults on a non-boolean flag value", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x\ndescription: d\nuser-invocable: sometimes`);
    expect(getSkillList({ cwd, home: cwd, userPaths: [] })[0]?.userInvocable).toBe(true);
  });

  it("reads yes/no as booleans", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(
      projectRoot,
      "x",
      `name: x\ndescription: d\ndisable-model-invocation: yes\nuser-invocable: no`,
    );
    const item = getSkillList({ cwd, home: cwd, userPaths: [] })[0];
    expect(item?.disableModelInvocation).toBe(true);
    expect(item?.userInvocable).toBe(false);
  });

  it("appends when_to_use to the description", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(
      projectRoot,
      "x",
      `name: x\ndescription: Review a diff.\nwhen_to_use: Use when the user asks what changed.`,
    );
    expect(getSkillList({ cwd, home: cwd, userPaths: [] })[0]?.description).toBe(
      "Review a diff. Use when the user asks what changed.",
    );
  });

  it("leaves the description untouched when when_to_use is absent", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x\ndescription: d`);
    expect(getSkillList({ cwd, home: cwd, userPaths: [] })[0]?.description).toBe("d");
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

  it("carries a verbose real-world description verbatim", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    // ~1.1k chars — the length of the most verbose skills shipped with other
    // agent runtimes. The old 200-char cap cut these to the first sentence and
    // threw away the trigger keywords the model actually routes on.
    const desc = "Use this skill whenever you need to do the thing. ".repeat(22).trim();
    writeSkill(projectRoot, "x", `name: x\ndescription: ${desc}`);
    expect(getSkillList({ cwd, home: cwd, userPaths: [] })[0]?.description).toBe(desc);
  });

  it("does not truncate a description at any length", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    const desc = "x".repeat(5000);
    writeSkill(projectRoot, "x", `name: x\ndescription: ${desc}`);
    expect(getSkillList({ cwd, home: cwd, userPaths: [] })[0]?.description).toBe(desc);
  });

  it("keeps when_to_use whole behind a long description", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    // Under the old cap a 2000-char description consumed the entire budget and
    // when_to_use — the field that exists purely to carry trigger context —
    // never reached the index at all.
    const desc = "d".repeat(2000);
    const when = "w".repeat(800);
    writeSkill(projectRoot, "x", `name: x\ndescription: ${desc}\nwhen_to_use: ${when}`);
    expect(getSkillList({ cwd, home: cwd, userPaths: [] })[0]?.description).toBe(
      `${desc} ${when}`,
    );
  });
});

// Front-matter shapes that are ordinary YAML and common in skills authored for
// other agent runtimes. The previous line-oriented parser threw on every one of
// them, and a throw meant the skill vanished from the index with only a log
// line — so these are regression tests for silent disappearance, not for
// parsing niceties.
describe("getSkillList — front-matter shapes that must not drop a skill", () => {
  function loadOne(fm: string) {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "s", fm);
    return getSkillList({ cwd, home: cwd, userPaths: [] })[0];
  }

  it("keeps a skill carrying a nested metadata map", () => {
    const item = loadOne(`name: s\ndescription: d\nmetadata:\n  category: docs\n  version: 2`);
    expect(item?.name).toBe("s");
    expect(item?.description).toBe("d");
  });

  it("keeps a skill whose description is a folded block scalar", () => {
    const item = loadOne(`name: s\ndescription: >\n  a folded multi-line\n  description string`);
    expect(item?.description).toBe("a folded multi-line description string");
  });

  it("keeps a skill whose description is a literal block scalar", () => {
    const item = loadOne(`name: s\ndescription: |\n  line one\n  line two`);
    expect(item?.description).toBe("line one\nline two");
  });

  it("keeps a skill whose description wraps onto a continuation line", () => {
    const item = loadOne(`name: s\ndescription: starts here\n  and continues there`);
    expect(item?.description).toBe("starts here and continues there");
  });

  it("keeps a skill declaring capability fields nova does not implement yet", () => {
    const item = loadOne(
      [
        "name: s",
        "description: d",
        "allowed-tools:",
        "  - Read",
        "  - Bash(git status:*)",
        "model: inherit",
        "hooks:",
        "  PreToolUse:",
        "    - matcher: Bash",
        "      command: ./check.sh",
      ].join("\n"),
    );
    expect(item?.name).toBe("s");
    expect(item?.userInvocable).toBe(true);
  });

  it("keeps a description containing a colon", () => {
    expect(loadOne(`name: s\ndescription: Use this: for X`)?.description).toBe("Use this: for X");
  });

  it("keeps a skill despite an unparseable stray line", () => {
    expect(loadOne(`name: s\nthis line has no colon at all\ndescription: d`)?.description).toBe(
      "d",
    );
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

  it("follows a symlinked skill directory", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    // The real skill lives outside the scanned root and is linked into it —
    // the usual way one skill is shared across checkouts. `withFileTypes`
    // reports the entry as a symlink, not a directory, so this used to vanish.
    const external = join(cwd, "external");
    mkdirSync(external, { recursive: true });
    writeSkill(external, "linked", `name: linked\ndescription: d`);
    symlinkSync(join(external, "linked"), join(projectRoot, "linked"), "dir");
    const item = getSkillList({ cwd, home: cwd, userPaths: [] })[0];
    expect(item?.name).toBe("linked");
    expect(getSkill({ name: "linked" }, { cwd, home: cwd, userPaths: [] })?.body).toBe("BODY\n");
  });

  it("ignores a symlink that does not resolve to a directory", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(cwd, "loose.txt"), "not a skill", "utf8");
    symlinkSync(join(cwd, "loose.txt"), join(projectRoot, "loose"));
    symlinkSync(join(cwd, "missing"), join(projectRoot, "dangling"));
    const logger = { warn: vi.fn() };
    expect(getSkillList({ cwd, home: cwd, userPaths: [], logger })).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("getSkillList — plugin attribution", () => {
  function pluginFixture() {
    const cwd = fixture();
    const skillsRoot = join(cwd, "plugins", "demo", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    writeSkill(skillsRoot, "from-plugin", `name: from-plugin\ndescription: d`);
    return { cwd, skillsRoot, pluginRoot: join(cwd, "plugins", "demo") };
  }

  it("tags a skill with the plugin root that owns its directory", () => {
    const { cwd, skillsRoot, pluginRoot } = pluginFixture();
    const item = getSkillList({
      cwd,
      home: cwd,
      projectDirs: [],
      userPaths: [],
      extraDirs: [skillsRoot],
      pluginRoots: { [skillsRoot]: pluginRoot },
    })[0];
    expect(item?.name).toBe("from-plugin");
    expect(item?.pluginRoot).toBe(pluginRoot);
  });

  it("carries the plugin root through getSkill", () => {
    const { cwd, skillsRoot, pluginRoot } = pluginFixture();
    const opts = {
      cwd,
      home: cwd,
      projectDirs: [],
      userPaths: [],
      extraDirs: [skillsRoot],
      pluginRoots: { [skillsRoot]: pluginRoot },
    };
    expect(getSkill({ name: "from-plugin" }, opts)?.pluginRoot).toBe(pluginRoot);
  });

  it("leaves pluginRoot unset for a skill from an unattributed extraDir", () => {
    const { cwd, skillsRoot } = pluginFixture();
    const item = getSkillList({
      cwd,
      home: cwd,
      projectDirs: [],
      userPaths: [],
      extraDirs: [skillsRoot],
    })[0];
    expect(item?.pluginRoot).toBeUndefined();
  });

  it("keys the scan cache on pluginRoots", () => {
    const { cwd, skillsRoot, pluginRoot } = pluginFixture();
    const base = { cwd, home: cwd, projectDirs: [], userPaths: [], extraDirs: [skillsRoot] };
    expect(getSkillList(base)[0]?.pluginRoot).toBeUndefined();
    expect(getSkillList({ ...base, pluginRoots: { [skillsRoot]: pluginRoot } })[0]?.pluginRoot).toBe(
      pluginRoot,
    );
  });
});

describe("getSkillList — file size cap", () => {
  function withSize(bytes: number, opts?: { maxFileBytes?: number }) {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(join(projectRoot, "big"), { recursive: true });
    const body = "b".repeat(Math.max(0, bytes - 40));
    writeFileSync(join(projectRoot, "big/SKILL.md"), `---\nname: big\ndescription: d\n---\n${body}`);
    const logger = { warn: vi.fn() };
    const list = getSkillList({
      cwd,
      home: cwd,
      userPaths: [],
      logger,
      ...(opts?.maxFileBytes !== undefined ? { maxFileBytes: opts.maxFileBytes } : {}),
    });
    return { list, logger, cwd };
  }

  it("skips an oversized SKILL.md and warns", () => {
    const { list, logger } = withSize(5_000, { maxFileBytes: 1_000 });
    expect(list).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0]?.err)).toContain("maxFileBytes");
  });

  it("keeps a file at or under the cap", () => {
    const { list, logger } = withSize(500, { maxFileBytes: 1_000 });
    expect(list.map((s) => s.name)).toEqual(["big"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("defaults to a 1 MiB cap, so ordinary files are unaffected", () => {
    const { list } = withSize(200_000);
    expect(list.map((s) => s.name)).toEqual(["big"]);
  });

  it("re-applies the cap in getSkill when the file grew after the scan", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(join(projectRoot, "x"), { recursive: true });
    const path = join(projectRoot, "x/SKILL.md");
    writeFileSync(path, `---\nname: x\ndescription: d\n---\nsmall`);
    const opts = { cwd, home: cwd, userPaths: [], maxFileBytes: 500 };
    expect(getSkill({ name: "x" }, opts)?.body).toBe("small");
    writeFileSync(path, `---\nname: x\ndescription: d\n---\n${"g".repeat(2000)}`);
    expect(getSkill({ name: "x" }, opts)).toBeUndefined();
  });

  it("keys the scan cache on maxFileBytes", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(join(projectRoot, "x"), { recursive: true });
    writeFileSync(join(projectRoot, "x/SKILL.md"), `---\nname: x\ndescription: d\n---\n${"b".repeat(2000)}`);
    expect(getSkillList({ cwd, home: cwd, userPaths: [], maxFileBytes: 500 })).toEqual([]);
    expect(
      getSkillList({ cwd, home: cwd, userPaths: [], maxFileBytes: 10_000 }).map((s) => s.name),
    ).toEqual(["x"]);
  });
});

describe("getSkill", () => {
  it("returns body and location for a known name", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x\ndescription: d`, "  hello body  ");
    const loaded = getSkill({ name: "x" }, { cwd, home: cwd, userPaths: [] });
    expect(loaded?.body.startsWith("hello body")).toBe(true);
    expect(loaded?.location).toBe(join(projectRoot, "x"));
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
    const loaded = getSkill({ name: "same" }, { cwd, home });
    expect(loaded?.body.includes("PROJECT")).toBe(true);
    expect(loaded?.location).toBe(join(cwd, ".nova/skills/same"));
  });

  it("reads SKILL.md fresh on each call (not from a cached body)", () => {
    const cwd = fixture();
    const projectRoot = join(cwd, ".nova/skills");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(projectRoot, "x", `name: x\ndescription: d`, "FIRST");
    expect(getSkill({ name: "x" }, { cwd, home: cwd, userPaths: [] })?.body).toContain("FIRST");
    writeFileSync(
      join(projectRoot, "x/SKILL.md"),
      `---\nname: x\ndescription: d\n---\nSECOND\n`,
    );
    expect(getSkill({ name: "x" }, { cwd, home: cwd, userPaths: [] })?.body).toContain("SECOND");
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
