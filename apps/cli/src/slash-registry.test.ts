import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@nova/runtime";
import {
  SlashRegistry,
  expandCommandBody,
  expandPlaceholders,
  fileCommandToSlash,
  loadFileCommands,
  parseCommandFile,
  type FileCommandRaw,
} from "./slash-registry.js";

/** Parse a command file and return its `ok` payload or throw the parse error. */
function parseOk(path: string, md: string): FileCommandRaw {
  const out = parseCommandFile(path, md, "project");
  if (!("ok" in out)) throw new Error(`expected ok, got error: ${out.error}`);
  return out.ok;
}

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
      'argHint: "[focus]"',
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

describe("parseCommandFile front-matter YAML subset", () => {
  it("parses a block-style array of bare-string args", () => {
    const md = ["---", "name: x", "args:", "  - alpha", "  - beta", "---", "body"].join("\n");
    expect(parseOk("/tmp/x.md", md).args).toEqual([{ name: "alpha" }, { name: "beta" }]);
  });

  it("parses a flow-style array of bare-string args", () => {
    const md = ["---", "name: x", "args: [alpha, beta]", "---", "body"].join("\n");
    expect(parseOk("/tmp/x.md", md).args).toEqual([{ name: "alpha" }, { name: "beta" }]);
  });

  it("keeps a quoted comma inside an inline-object default (splitFlowPairs)", () => {
    const md = ["---", "name: x", "args:", '  - { name: msg, default: "a,b" }', "---", "body"].join(
      "\n",
    );
    expect(parseOk("/tmp/x.md", md).args).toEqual([{ name: "msg", default: "a,b" }]);
  });

  it("ignores comments and blank lines in front-matter", () => {
    const md = ["---", "# a comment", "name: x", "", "description: hi", "---", "body"].join("\n");
    const ok = parseOk("/tmp/x.md", md);
    expect(ok.name).toBe("x");
    expect(ok.description).toBe("hi");
  });

  it("rejects args that are a scalar instead of an array", () => {
    const md = ["---", "name: x", "args: nope", "---", "body"].join("\n");
    expect("error" in parseCommandFile("/tmp/x.md", md, projectKind)).toBe(true);
  });

  it("rejects an arg object with an empty name", () => {
    const md = ["---", "name: x", "args:", "  - { required: true }", "---", "body"].join("\n");
    expect("error" in parseCommandFile("/tmp/x.md", md, projectKind)).toBe(true);
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
    const r = expandPlaceholders("focus={{focus}}", [{ name: "focus", default: "perf" }], "");
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

  it("expands a missing optional arg (no default) to the empty string", () => {
    const r = expandPlaceholders("x={{opt}}", [{ name: "opt" }], "");
    if (!("ok" in r)) throw new Error("expected ok");
    expect(r.ok).toBe("x=");
  });

  it("prefers the supplied value over an inline default", () => {
    const r = expandPlaceholders("{{a|fallback}}", [{ name: "a" }], "given");
    if (!("ok" in r)) throw new Error("expected ok");
    expect(r.ok).toBe("given");
  });
});

describe("expandCommandBody — Claude Code syntax", () => {
  const cwd = process.cwd();

  it("substitutes $ARGUMENTS and $1..$N positionals", async () => {
    const r = await expandCommandBody("all=$ARGUMENTS first=$1 second=$2", [], "alpha beta", {
      cwd,
    });
    expect(r).toEqual({ ok: "all=alpha beta first=alpha second=beta" });
  });

  it("expands a missing positional to empty and still surfaces the typed args", async () => {
    // The placeholder resolves to nothing, so nothing carried "only" into the
    // prompt — the fallback has to, or the argument is lost outright. This used
    // to yield a bare "x=" with the user's input nowhere in the request.
    const r = await expandCommandBody("x=$2", [], "only", { cwd });
    expect(r).toEqual({ ok: "x=\n\nARGUMENTS: only" });
  });

  it("stays quiet when another placeholder did consume the args", async () => {
    const r = await expandCommandBody("$1 then $2", [], "only", { cwd });
    expect(r).toEqual({ ok: "only then " });
  });

  it("leaves non-arg dollar tokens (e.g. $HOME) untouched", async () => {
    const r = await expandCommandBody("echo $HOME and $1", [], "v", { cwd });
    expect(r).toEqual({ ok: "echo $HOME and v" });
  });

  it("substitutes the 0-indexed $ARGUMENTS[n] form", async () => {
    const r = await expandCommandBody("[$ARGUMENTS[0]][$ARGUMENTS[1]]", [], "a b", { cwd });
    expect(r).toEqual({ ok: "[a][b]" });
  });

  it("substitutes $name from the same values the {{name}} layer resolved", async () => {
    const args = [{ name: "target" }];
    const r = await expandCommandBody("{{target}} == $target", args, "src/app.ts", { cwd });
    expect(r).toEqual({ ok: "src/app.ts == src/app.ts" });
  });

  it("honours \\$ escaping", async () => {
    const r = await expandCommandBody("literal \\$1 vs real $1", [], "v", { cwd });
    expect(r).toEqual({ ok: "literal $1 vs real v" });
  });

  it("appends an ARGUMENTS line when nothing consumed the typed args", async () => {
    const r = await expandCommandBody("just do it", [], "with feeling", { cwd });
    expect(r).toEqual({ ok: "just do it\n\nARGUMENTS: with feeling" });
  });

  it("does not append when a $ placeholder consumed the args", async () => {
    const r = await expandCommandBody("do $1", [], "it", { cwd });
    expect(r).toEqual({ ok: "do it" });
  });

  it("does not append when a {{}} placeholder consumed the args", async () => {
    const r = await expandCommandBody("do {{args}}", [], "it", { cwd });
    expect(r).toEqual({ ok: "do it" });
  });

  it("does not append when no args were typed", async () => {
    const r = await expandCommandBody("just do it", [], "", { cwd });
    expect(r).toEqual({ ok: "just do it" });
  });

  it("appends when the only dollar reference was escaped", async () => {
    const r = await expandCommandBody("print \\$1", [], "v", { cwd });
    expect(r).toEqual({ ok: "print $1\n\nARGUMENTS: v" });
  });

  it("interpolates !`cmd` via the injected runCommand", async () => {
    const r = await expandCommandBody("status:\n!`git status`", [], "", {
      cwd,
      runCommand: async (command) => ({ output: `ran<${command}>\n`, isError: false }),
    });
    expect(r).toEqual({ ok: "status:\nran<git status>" });
  });

  it("leaves !`cmd` verbatim when no runner is wired", async () => {
    const r = await expandCommandBody("!`echo hi`", [], "", { cwd });
    expect(r).toEqual({ ok: "!`echo hi`" });
  });

  it("embeds @path when the file exists and leaves @scope/pkg alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-embed-"));
    await writeFile(join(dir, "note.txt"), "hello world", "utf8");
    const r = await expandCommandBody("see @note.txt and @scope/pkg", [], "", { cwd: dir });
    if (!("ok" in r)) throw new Error(r.error);
    expect(r.ok).toContain("Contents of note.txt:");
    expect(r.ok).toContain("hello world");
    expect(r.ok).toContain("@scope/pkg");
  });

  it("feeds substituted args into a !`cmd` segment", async () => {
    const r = await expandCommandBody("!`show $1`", [], "abc123", {
      cwd,
      runCommand: async (command) => ({ output: command.toUpperCase(), isError: false }),
    });
    expect(r).toEqual({ ok: "SHOW ABC123" });
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

  it("clearKind removes only commands of that kind", () => {
    const r = new SlashRegistry();
    r.register(builtin("keep"));
    r.register({
      name: "drop",
      description: "file cmd",
      source: { kind: projectKind, path: "/p/drop.md" },
      run: () => ({ kind: "handled" }),
    });
    r.clearKind(projectKind);
    expect(r.resolve("/keep")?.cmd.name).toBe("keep");
    expect(r.resolve("/drop")).toBeNull();
  });

  it("lists commands sorted by name", () => {
    const r = new SlashRegistry();
    r.register(builtin("charlie"));
    r.register(builtin("alpha"));
    r.register(builtin("bravo"));
    expect(r.list().map((c) => c.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("resolve preserves the exact arg string after the first whitespace", () => {
    const r = new SlashRegistry();
    r.register(builtin("cmd"));
    expect(r.resolve("/cmd   x  y")?.args).toBe("  x  y");
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

  it("namespaces subdirectory commands as dir:name", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-slash-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "nova-slash-home-"));
    await mkdir(join(cwd, ".nova/commands/frontend"), { recursive: true });
    await writeFile(join(cwd, ".nova/commands/frontend/component.md"), "scaffold a component\n");
    await writeFile(join(cwd, ".nova/commands/review.md"), "review the diff\n");

    const result = await loadFileCommands({ cwd, home });
    const names = result.commands.map((c) => c.name).sort();
    expect(names).toEqual(["frontend:component", "review"]);
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

  it("scans extraDirs (after user paths) and reports per-target counts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-slash-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "nova-slash-home-"));
    const extra = await mkdtemp(join(tmpdir(), "nova-slash-extra-"));
    await writeFile(join(extra, "extra-cmd.md"), "from extra dir\n");

    const result = await loadFileCommands({
      cwd,
      home,
      projectDirs: [],
      userPaths: [],
      extraDirs: [extra],
    });
    expect(result.commands.map((c) => c.name)).toEqual(["extra-cmd"]);
    // extraDirs entries are reported under the "user" layer in `scanned`.
    expect(result.scanned).toContainEqual({ kind: "user", path: extra, found: 1 });
  });

  it("drops a same-named file that loses the scan order, keeping the winner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nova-slash-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "nova-slash-home-"));
    await mkdir(join(cwd, "a"), { recursive: true });
    await mkdir(join(cwd, "b"), { recursive: true });
    await writeFile(join(cwd, "a/dup.md"), "winner\n");
    await writeFile(join(cwd, "b/dup.md"), "loser\n");

    const result = await loadFileCommands({
      cwd,
      home,
      projectDirs: ["a", "b"],
      userPaths: [],
    });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.body.trim()).toBe("winner");
  });
});

describe("fileCommandToSlash", () => {
  it("produces a prompt outcome with expanded body", async () => {
    const parsed = parseCommandFile("/tmp/hello.md", "Hello {{name|world}}!\n", projectKind);
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

  it("derives an argHint with <required> and [optional] markers", () => {
    const raw: FileCommandRaw = {
      name: "x",
      description: "d",
      args: [{ name: "target", required: true }, { name: "focus" }],
      body: "{{target}} {{focus}}",
      path: "/p/x.md",
      kind: "project",
    };
    expect(fileCommandToSlash(raw).argHint).toBe("<target> [focus]");
  });

  it("omits argHint when the command declares no args", () => {
    const raw: FileCommandRaw = {
      name: "x",
      description: "d",
      args: [],
      body: "no args",
      path: "/p/x.md",
      kind: "project",
    };
    expect(fileCommandToSlash(raw).argHint).toBeUndefined();
  });
});
