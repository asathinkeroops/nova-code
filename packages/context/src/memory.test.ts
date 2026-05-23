import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadMemory } from "./memory.js";

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nova-memory-"));
  home = await mkdtemp(join(tmpdir(), "nova-home-"));
  // Mark root as a repo so upward walking stops there.
  await mkdir(join(root, ".git"), { recursive: true });
});

async function writeFileEnsuringDir(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
}

describe("loadMemory", () => {
  it("loads all three layers when present", async () => {
    const globalPath = join(home, ".nova", "global.md");
    await writeFileEnsuringDir(globalPath, "global content");
    await writeFileEnsuringDir(join(home, ".nova", "NOVA.md"), "user-nova content");
    await writeFile(join(root, "NOVA.md"), "project-nova content", "utf8");

    const bundle = await loadMemory(root, { home, globalPath });

    const layers = bundle.sources.map((s) => s.layer);
    expect(layers).toEqual(["global", "user", "project"]);
    expect(bundle.system).toContain("global content");
    expect(bundle.system).toContain("user-nova content");
    expect(bundle.system).toContain("project-nova content");
    // Project section must appear after user (so the model treats it as override).
    expect(bundle.system.indexOf("project-nova content")).toBeGreaterThan(
      bundle.system.indexOf("user-nova content"),
    );
  });

  it("skips layers that are absent", async () => {
    const bundle = await loadMemory(root, { home });
    expect(bundle.sources).toEqual([]);
    expect(bundle.system).toBe("");
  });

  it("walks upward from a nested cwd, deeper directory wins by appearing last", async () => {
    await writeFile(join(root, "NOVA.md"), "outer", "utf8");
    const inner = join(root, "a", "b");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "NOVA.md"), "inner", "utf8");

    const bundle = await loadMemory(inner, { home });
    const projectSources = bundle.sources.filter((s) => s.layer === "project");
    expect(projectSources.map((s) => s.filename)).toEqual(["NOVA.md", "NOVA.md"]);
    expect(bundle.system.indexOf("inner")).toBeGreaterThan(bundle.system.indexOf("outer"));
  });

  it("prefers NOVA.md over CLAUDE.md in the same directory", async () => {
    await writeFile(join(root, "NOVA.md"), "nova", "utf8");
    await writeFile(join(root, "CLAUDE.md"), "claude", "utf8");

    const bundle = await loadMemory(root, { home });
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.filename).toBe("NOVA.md");
    expect(bundle.system).toContain("nova");
    expect(bundle.system).not.toContain("claude");
  });

  it("prefers CLAUDE.md over AGENTS.md in the same directory", async () => {
    await writeFile(join(root, "CLAUDE.md"), "claude", "utf8");
    await writeFile(join(root, "AGENTS.md"), "agents", "utf8");

    const bundle = await loadMemory(root, { home });
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.filename).toBe("CLAUDE.md");
    expect(bundle.system).toContain("claude");
    expect(bundle.system).not.toContain("agents");
  });

  it("falls back to AGENTS.md when it is the only memory file", async () => {
    await writeFile(join(root, "AGENTS.md"), "agents only", "utf8");

    const bundle = await loadMemory(root, { home });
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.filename).toBe("AGENTS.md");
    expect(bundle.system).toContain("agents only");
  });

  it("respects the filenames override (priority order)", async () => {
    await writeFile(join(root, "NOVA.md"), "nova", "utf8");
    await writeFile(join(root, "CLAUDE.md"), "claude", "utf8");

    const bundle = await loadMemory(root, {
      home,
      filenames: ["CLAUDE.md", "NOVA.md"],
    });
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.filename).toBe("CLAUDE.md");
  });

  it("records the actual user file that was matched", async () => {
    // Only the second candidate exists — confirms first-existing-wins logic.
    await writeFileEnsuringDir(join(home, ".claude", "CLAUDE.md"), "user-claude");

    const bundle = await loadMemory(root, { home });
    const userSources = bundle.sources.filter((s) => s.layer === "user");
    expect(userSources).toHaveLength(1);
    expect(userSources[0]?.filename).toBe("CLAUDE.md");
    expect(userSources[0]?.path).toBe(join(home, ".claude", "CLAUDE.md"));
  });
});
