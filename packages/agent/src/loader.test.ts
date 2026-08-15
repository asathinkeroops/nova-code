import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentDefinitions } from "./loader.js";

describe("loadAgentDefinitions", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agents-proj-"));
    home = await mkdtemp(join(tmpdir(), "agents-home-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  async function writeAgent(dir: string, file: string, content: string): Promise<void> {
    const full = join(root, dir);
    await mkdir(full, { recursive: true });
    await writeFile(join(full, file), content, "utf8");
  }

  it("parses front-matter fields and the body into a definition", async () => {
    await writeAgent(
      ".nova/agents",
      "reviewer.md",
      [
        "---",
        "name: code-reviewer",
        "description: Reviews code for quality and security",
        "tools: [read, grep, glob]",
        "readOnly: true",
        "model: special-model",
        "maxTurns: 12",
        "maxTokens: 4096",
        "---",
        "You are an expert code reviewer.",
      ].join("\n"),
    );

    const { defs, errors } = loadAgentDefinitions({ cwd: root, home });

    expect(errors).toHaveLength(0);
    expect(defs).toHaveLength(1);
    const d = defs[0]!;
    expect(d.name).toBe("code-reviewer");
    expect(d.description).toBe("Reviews code for quality and security");
    expect(d.allowTools).toEqual(["read", "grep", "glob"]);
    expect(d.readOnly).toBe(true);
    expect(d.model).toBe("special-model");
    expect(d.maxTurns).toBe(12);
    expect(d.maxTokens).toBe(4096);
    expect(d.guidance).toBe("You are an expert code reviewer.");
    expect(d.source).toBe("project");
  });

  it("defaults readOnly to false and leaves optional fields unset", async () => {
    await writeAgent(
      ".nova/agents",
      "worker.md",
      ["---", "name: worker", "description: does work", "---", "body"].join("\n"),
    );

    const { defs } = loadAgentDefinitions({ cwd: root, home });

    expect(defs).toHaveLength(1);
    expect(defs[0]!.readOnly).toBe(false);
    expect(defs[0]!.allowTools).toBeUndefined();
    expect(defs[0]!.model).toBeUndefined();
    expect(defs[0]!.maxTurns).toBeUndefined();
  });

  it("reports parse errors for missing name / description", async () => {
    await writeAgent(".nova/agents", "bad.md", ["---", "description: no name", "---", "b"].join("\n"));

    const { defs, errors } = loadAgentDefinitions({ cwd: root, home });

    expect(defs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/name/);
  });

  it("project definitions shadow same-named user definitions", async () => {
    await writeAgent(
      ".nova/agents",
      "dup.md",
      ["---", "name: dup", "description: from project", "---", "p"].join("\n"),
    );
    const userDir = join(home, ".nova", "agents");
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "dup.md"),
      ["---", "name: dup", "description: from user", "---", "u"].join("\n"),
      "utf8",
    );

    const { defs } = loadAgentDefinitions({ cwd: root, home });

    expect(defs).toHaveLength(1);
    expect(defs[0]!.description).toBe("from project");
    expect(defs[0]!.source).toBe("project");
  });

  it("returns nothing when no agent dirs exist", async () => {
    const { defs, errors } = loadAgentDefinitions({ cwd: root, home });
    expect(defs).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
