import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bashRunnerFor, createLoadSkillTool, expandSkillBody } from "./load-skill.js";

describe("createLoadSkillTool", () => {
  it("returns an isError result for unknown skill names", async () => {
    const tool = createLoadSkillTool(() => undefined);
    const result = await tool.run({ name: "missing" }, { cwd: "/" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unknown skill: missing");
    expect(result.output).toContain("/skills");
  });

  it("wraps body in a <skill> tag with name and location for known skills", async () => {
    const tool = createLoadSkillTool(({ name }) =>
      name === "code-reviewer"
        ? { body: "do the thing", location: "/skills/code-reviewer" }
        : undefined,
    );
    const result = await tool.run({ name: "code-reviewer" }, { cwd: "/" });
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe(
      `<skill name="code-reviewer" location="/skills/code-reviewer">\ndo the thing\n</skill>`,
    );
  });

  it("truncates and appends a hint when body exceeds maxResponseBytes", async () => {
    const big = "x".repeat(10_000);
    const tool = createLoadSkillTool(() => ({ body: big, location: "/s/huge" }), {
      maxResponseBytes: 100,
    });
    const result = await tool.run({ name: "huge" }, { cwd: "/" });
    expect(result.output).toContain("…(truncated.");
    expect(result.output).toContain("settings.skills.maxResponseBytes");
    expect(result.output).toContain(`location="/s/huge"`);
    // Body inside the tag should be capped to 100 chars + newline + hint.
    expect(result.output.length).toBeLessThan(500);
  });

  it("sees fresh values when the injected getSkill function returns new data", async () => {
    let stored = "first";
    const tool = createLoadSkillTool(() => ({ body: stored, location: "/s/x" }));
    const a = await tool.run({ name: "x" }, { cwd: "/" });
    expect(a.output).toContain("first");
    stored = "second";
    const b = await tool.run({ name: "x" }, { cwd: "/" });
    expect(b.output).toContain("second");
  });

  it("returns isError when input fails schema validation", async () => {
    const tool = createLoadSkillTool(() => ({ body: "body", location: "/s/x" }));
    await expect(tool.run({ name: "" }, { cwd: "/" })).rejects.toThrow();
  });
});

describe("expandSkillBody — variables", () => {
  const at = (body: string) =>
    expandSkillBody(body, { location: "/skills/demo", cwd: "/work/repo" });

  it("substitutes the skill directory under both spellings", async () => {
    expect(await at("run ${CLAUDE_SKILL_DIR}/go.sh and ${NOVA_SKILL_DIR}/x")).toBe(
      "run /skills/demo/go.sh and /skills/demo/x",
    );
  });

  it("substitutes the project directory under both spellings", async () => {
    expect(await at("${CLAUDE_PROJECT_DIR} ${NOVA_PROJECT_DIR}")).toBe("/work/repo /work/repo");
  });

  it("leaves an unknown variable verbatim rather than blanking it", async () => {
    expect(await at("see ${SOME_OTHER_TOOL_VAR} docs")).toBe("see ${SOME_OTHER_TOOL_VAR} docs");
  });

  it("ignores lowercase ${...} so prose and code samples survive", async () => {
    expect(await at("in JS write ${name} for interpolation")).toBe(
      "in JS write ${name} for interpolation",
    );
  });

  it("substitutes plugin root, session id and effort when supplied", async () => {
    const out = await expandSkillBody("${CLAUDE_PLUGIN_ROOT} ${CLAUDE_SESSION_ID} ${CLAUDE_EFFORT}", {
      location: "/skills/demo",
      cwd: "/work",
      pluginRoot: "/plugins/p",
      sessionId: "sess-1",
      effort: "high",
    });
    expect(out).toBe("/plugins/p sess-1 high");
  });

  it("accepts the NOVA_ spelling for the same three", async () => {
    const out = await expandSkillBody("${NOVA_PLUGIN_ROOT} ${NOVA_SESSION_ID} ${NOVA_EFFORT}", {
      location: "/skills/demo",
      cwd: "/work",
      pluginRoot: "/plugins/p",
      sessionId: "sess-1",
      effort: "high",
    });
    expect(out).toBe("/plugins/p sess-1 high");
  });

  it("leaves the reference visible when a value is not available", async () => {
    // A skill outside any plugin, loaded without a session: a blank would read
    // as "resolved to nothing" rather than "not applicable here".
    expect(await at("[${CLAUDE_PLUGIN_ROOT}][${CLAUDE_SESSION_ID}]")).toBe(
      "[${CLAUDE_PLUGIN_ROOT}][${CLAUDE_SESSION_ID}]",
    );
  });

  it("substitutes every occurrence, not just the first", async () => {
    expect(await at("${NOVA_SKILL_DIR}:${NOVA_SKILL_DIR}:${NOVA_SKILL_DIR}")).toBe(
      "/skills/demo:/skills/demo:/skills/demo",
    );
  });
});

describe("expandSkillBody — @path embedding", () => {
  it("embeds a readable file relative to cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-skillexp-"));
    writeFileSync(join(dir, "notes.txt"), "hello from disk", "utf8");
    const out = await expandSkillBody("context: @notes.txt", {
      location: dir,
      cwd: dir,
    });
    expect(out).toContain("Contents of notes.txt:");
    expect(out).toContain("hello from disk");
  });

  it("leaves a non-file mention verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-skillexp-"));
    const out = await expandSkillBody("mail me at a@b.com and use @scope/pkg", {
      location: dir,
      cwd: dir,
    });
    expect(out).toBe("mail me at a@b.com and use @scope/pkg");
  });

  it("resolves a mention through an expanded skill-dir variable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-skillexp-"));
    writeFileSync(join(dir, "ref.md"), "REFERENCE", "utf8");
    // Variables expand before mentions, so ${NOVA_SKILL_DIR}/ref.md becomes an
    // absolute path that the @ stage can then read.
    const out = await expandSkillBody("@${NOVA_SKILL_DIR}/ref.md", {
      location: dir,
      cwd: dir,
    });
    expect(out).toContain("REFERENCE");
  });
});

describe("expandSkillBody — inline shell", () => {
  const shellCtx = { cwd: process.cwd() };

  it("runs !`cmd` through the injected runner and inlines its output", async () => {
    const out = await expandSkillBody("branch: !`echo main`", {
      location: "/s/x",
      cwd: shellCtx.cwd,
      runCommand: bashRunnerFor(shellCtx),
    });
    expect(out).toBe("branch: main");
  });

  it("leaves !`cmd` verbatim when no runner is injected", async () => {
    const out = await expandSkillBody("branch: !`echo main`", {
      location: "/s/x",
      cwd: shellCtx.cwd,
    });
    expect(out).toBe("branch: !`echo main`");
  });

  it("replaces !`cmd` with a notice when execution is disabled", async () => {
    const out = await expandSkillBody("branch: !`echo main`", {
      location: "/s/x",
      cwd: shellCtx.cwd,
      runCommand: bashRunnerFor(shellCtx),
      disableShellExecution: true,
    });
    expect(out).toBe("branch: [shell command execution disabled by settings]");
    expect(out).not.toContain("main");
  });

  it("expands variables and arguments into the command before running it", async () => {
    const out = await expandSkillBody("!`echo ${NOVA_SKILL_DIR} $1`", {
      location: "/skills/demo",
      cwd: shellCtx.cwd,
      args: "extra",
      runCommand: bashRunnerFor(shellCtx),
    });
    expect(out).toBe("/skills/demo extra");
  });
});

describe("expandSkillBody — arguments", () => {
  const at = (body: string, args?: string) =>
    expandSkillBody(body, {
      location: "/skills/demo",
      cwd: "/work",
      ...(args !== undefined ? { args } : {}),
    });

  it("binds $ARGUMENTS and positionals when args are supplied", async () => {
    expect(await at("check $1 against $2 (all: $ARGUMENTS)", "alpha beta")).toBe(
      "check alpha against beta (all: alpha beta)",
    );
  });

  it("blanks positionals the user did not supply", async () => {
    expect(await at("[$1][$2]", "only")).toBe("[only][]");
  });

  it("leaves $ARGUMENTS untouched when no args key is present at all", async () => {
    // The loadSkill path omits `args` entirely; a body written for the slash
    // path must not silently lose its placeholders when the model loads it.
    expect(await at("run $ARGUMENTS")).toBe("run $ARGUMENTS");
  });

  it("blanks placeholders on an explicit empty arg string", async () => {
    expect(await at("run $ARGUMENTS", "")).toBe("run ");
  });
});

describe("createLoadSkillTool — expansion wiring", () => {
  it("expands the body before wrapping it", async () => {
    const tool = createLoadSkillTool(() => ({
      body: "cd ${CLAUDE_SKILL_DIR}",
      location: "/skills/demo",
    }));
    const result = await tool.run({ name: "demo" }, { cwd: "/work" });
    expect(result.output).toContain("cd /skills/demo");
    expect(result.output).not.toContain("${CLAUDE_SKILL_DIR}");
  });

  it("reads session and effort off the live tool context, not construction options", async () => {
    const tool = createLoadSkillTool(() => ({
      body: "${CLAUDE_SESSION_ID}/${CLAUDE_EFFORT}",
      location: "/s/x",
    }));
    const first = await tool.run({ name: "x" }, { cwd: "/w", sessionId: "s1", effort: "low" });
    expect(first.output).toContain("s1/low");
    // /effort and /resume change these mid-session; a captured value would go stale.
    const second = await tool.run({ name: "x" }, { cwd: "/w", sessionId: "s2", effort: "max" });
    expect(second.output).toContain("s2/max");
  });

  it("forwards the skill's plugin root when getSkill reports one", async () => {
    const tool = createLoadSkillTool(() => ({
      body: "${CLAUDE_PLUGIN_ROOT}/bin/run",
      location: "/plugins/p/skills/x",
      pluginRoot: "/plugins/p",
    }));
    const result = await tool.run({ name: "x" }, { cwd: "/w" });
    expect(result.output).toContain("/plugins/p/bin/run");
  });

  it("honours disableShellExecution from options", async () => {
    const tool = createLoadSkillTool(() => ({ body: "!`echo leak`", location: "/s/x" }), {
      disableShellExecution: true,
    });
    const result = await tool.run({ name: "x" }, { cwd: process.cwd() });
    expect(result.output).not.toContain("leak");
    expect(result.output).toContain("disabled by settings");
  });
});
