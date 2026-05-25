import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SlashRegistry,
  expandPlaceholders,
  fileCommandToSlash,
  loadFileCommands,
  parseCommandFile,
  type SlashCommand,
} from "./slash.js";

const projectKind = "project" as const;
const userKind = "user" as const;

function builtin(name: string, run?: SlashCommand["run"]): SlashCommand {
  return {
    name,
    description: `builtin ${name}`,
    source: { kind: "builtin" },
    run: run ?? (() => ({ kind: "handled" })),
  };
}

describe("parseCommandFile", () => {
  it("parses front-matter + body", () => {
    const md = [
      "---",
      "name: review",
      'description: "Audit the diff"',
      "argHint: \"[focus]\"",
      "args:",
      "  - { name: focus, required: false, default: safety }",
      "---",
      "Audit the diff focusing on {{focus}}.",
      "",
    ].join("\n");
    const out = parseCommandFile("/tmp/review.md", md, projectKind);
    expect("ok" in out).toBe(true);
    if (!("ok" in out)) return;
    expect(out.ok.name).toBe("review");
    expect(out.ok.description).toBe("Audit the diff");
    expect(out.ok.argHint).toBe("[focus]");
    expect(out.ok.args).toEqual([{ name: "focus", required: false, default: "safety" }]);
    expect(out.ok.body).toBe("Audit the diff focusing on {{focus}}.\n");
  });

  it("falls back to filename + first body line when front-matter is missing", () => {
    const out = parseCommandFile("/tmp/hello.md", "Say hello to {{args}}.\n", userKind);
    expect("ok" in out).toBe(true);
    if (!("ok" in out)) return;
    expect(out.ok.name).toBe("hello");
    expect(out.ok.description).toBe("Say hello to {{args}}.");
    expect(out.ok.args).toEqual([]);
  });

  it("reports malformed front-matter as an error", () => {
    const md = ["---", "this is not yaml", "---", "body"].join("\n");
    const out = parseCommandFile("/tmp/bad.md", md, projectKind);
    expect("error" in out).toBe(true);
  });

  it("rejects invalid command names", () => {
    const md = ["---", "name: 9bad", "---", "body"].join("\n");
    const out = parseCommandFile("/tmp/x.md", md, projectKind);
    expect("error" in out).toBe(true);
  });
});

describe("expandPlaceholders", () => {
  it("substitutes declared positional args, last absorbs remainder", () => {
    const r = expandPlaceholders(
      "{{first}} | {{rest}}",
      [{ name: "first" }, { name: "rest" }],
      "alpha beta gamma",
    );
    expect("ok" in r).toBe(true);
    if (!("ok" in r)) return;
    expect(r.ok).toBe("alpha | beta gamma");
  });

  it("uses inline default when arg missing", () => {
    const r = expandPlaceholders("focus={{focus|safety}}", [{ name: "focus" }], "");
    if (!("ok" in r)) throw new Error("expected ok");
    expect(r.ok).toBe("focus=safety");
  });

  it("uses spec default when arg missing", () => {
    const r = expandPlaceholders(
      "focus={{focus}}",
      [{ name: "focus", default: "perf" }],
      "",
    );
    if (!("ok" in r)) throw new Error("expected ok");
    expect(r.ok).toBe("focus=perf");
  });

  it("returns error when required arg missing", () => {
    const r = expandPlaceholders("{{x}}", [{ name: "x", required: true }], "");
    expect("error" in r).toBe(true);
  });

  it("returns error on unknown placeholder without default", () => {
    const r = expandPlaceholders("hello {{name}}", [], "");
    expect("error" in r).toBe(true);
  });

  it("exposes raw {{args}} alias", () => {
    const r = expandPlaceholders("you said: {{args}}", [], "  the quick brown fox  ");
    if (!("ok" in r)) throw new Error("expected ok");
    expect(r.ok).toBe("you said: the quick brown fox");
  });
});

describe("SlashRegistry", () => {
  it("resolves /name args", () => {
    const r = new SlashRegistry();
    r.register(builtin("compact"));
    expect(r.resolve("/compact")?.cmd.name).toBe("compact");
    expect(r.resolve("/compact focus one two")?.args).toBe("focus one two");
    expect(r.resolve("/unknown")).toBeNull();
    expect(r.resolve("hello")).toBeNull();
  });

  it("keeps builtin and records the file command as shadowed", () => {
    const r = new SlashRegistry();
    r.register(builtin("exit"));
    r.register({
      name: "exit",
      description: "user override",
      source: { kind: projectKind, path: "/p/.commands/exit.md" },
      run: () => ({ kind: "prompt", text: "" }),
    });
    const cmd = r.resolve("/exit")?.cmd;
    expect(cmd?.source.kind).toBe("builtin");
    expect(cmd?.source.shadowedBy?.[0]?.path).toBe("/p/.commands/exit.md");
  });

  it("file command registered before builtin still loses to builtin", () => {
    const r = new SlashRegistry();
    r.register({
      name: "exit",
      description: "user override",
      source: { kind: projectKind, path: "/p/.commands/exit.md" },
      run: () => ({ kind: "prompt", text: "" }),
    });
    r.register(builtin("exit"));
    const cmd = r.resolve("/exit")?.cmd;
    expect(cmd?.source.kind).toBe("builtin");
    expect(cmd?.source.shadowedBy?.[0]?.path).toBe("/p/.commands/exit.md");
  });
});

describe("loadFileCommands", () => {
  it("project layer beats user layer; nova beats claude", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-slash-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "nova-slash-home-"));
    await mkdir(join(cwd, ".nova/commands"), { recursive: true });
    await mkdir(join(cwd, ".claude/commands"), { recursive: true });
    await mkdir(join(home, ".nova/commands"), { recursive: true });
    await mkdir(join(home, ".claude/commands"), { recursive: true });

    await writeFile(join(cwd, ".nova/commands/dup.md"), "from project/.nova\n");
    await writeFile(join(cwd, ".claude/commands/dup.md"), "from project/.claude\n");
    await writeFile(join(home, ".nova/commands/dup.md"), "from user/.nova\n");
    await writeFile(join(home, ".claude/commands/dup.md"), "from user/.claude\n");
    await writeFile(join(cwd, ".claude/commands/only-claude.md"), "claude-only\n");
    await writeFile(join(home, ".claude/commands/user-only.md"), "user-only\n");

    const result = await loadFileCommands({ cwd, home });
    const byName = new Map(result.commands.map((c) => [c.name, c]));
    expect(byName.get("dup")?.body.trim()).toBe("from project/.nova");
    expect(byName.get("dup")?.kind).toBe("project");
    expect(byName.get("only-claude")?.kind).toBe("project");
    expect(byName.get("user-only")?.kind).toBe("user");
  });

  it("custom projectDirs and userPaths override defaults", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-slash-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "nova-slash-home-"));
    await mkdir(join(cwd, "myprompts"), { recursive: true });
    await writeFile(join(cwd, "myprompts/hi.md"), "hi from custom\n");

    const result = await loadFileCommands({
      cwd,
      home,
      projectDirs: ["myprompts"],
      userPaths: [],
    });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.name).toBe("hi");
    expect(result.commands[0]?.kind).toBe("project");
  });

  it("returns parse errors instead of throwing on bad files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-slash-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "nova-slash-home-"));
    await mkdir(join(cwd, ".nova/commands"), { recursive: true });
    await writeFile(join(cwd, ".nova/commands/ok.md"), "ok body\n");
    await writeFile(
      join(cwd, ".nova/commands/bad.md"),
      ["---", "garbage line with no key", "---", "body"].join("\n"),
    );
    const result = await loadFileCommands({ cwd, home });
    expect(result.commands.map((c) => c.name)).toEqual(["ok"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path.endsWith("bad.md")).toBe(true);
  });
});

describe("fileCommandToSlash", () => {
  it("produces a prompt outcome with expanded body", async () => {
    const parsed = parseCommandFile(
      "/tmp/hello.md",
      "Hello {{name|world}}!\n",
      projectKind,
    );
    if (!("ok" in parsed)) throw new Error("expected ok");
    const slash = fileCommandToSlash(parsed.ok);
    const outcome = await slash.run({ cwd: "/" }, "");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toBe("Hello world!\n");
  });

  it("returns an error outcome (not a prompt) when a required arg is missing", async () => {
    const md = [
      "---",
      "name: explain",
      "args:",
      "  - { name: target, required: true }",
      "---",
      "Explain {{target}}.",
    ].join("\n");
    const parsed = parseCommandFile("/tmp/explain.md", md, projectKind);
    if (!("ok" in parsed)) throw new Error("expected ok");
    const slash = fileCommandToSlash(parsed.ok);
    const outcome = await slash.run({ cwd: "/" }, "");
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain('missing required arg "target"');
  });
});
