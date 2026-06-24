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

  // bundle.system embeds each file's PATH alongside its body, and the tmp root
  // can contain words like "nova"/"claude" (e.g. TMPDIR under /tmp/claude-…).
  // Use distinctive body sentinels that can't appear in a path so the
  // "which file's content loaded" assertions don't collide with the path.
  it("prefers NOVA.md over CLAUDE.md in the same directory", async () => {
    await writeFile(join(root, "NOVA.md"), "NOVA_BODY", "utf8");
    await writeFile(join(root, "CLAUDE.md"), "CLAUDE_BODY", "utf8");

    const bundle = await loadMemory(root, { home });
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.filename).toBe("NOVA.md");
    expect(bundle.system).toContain("NOVA_BODY");
    expect(bundle.system).not.toContain("CLAUDE_BODY");
  });

  it("prefers CLAUDE.md over AGENTS.md in the same directory", async () => {
    await writeFile(join(root, "CLAUDE.md"), "CLAUDE_BODY", "utf8");
    await writeFile(join(root, "AGENTS.md"), "AGENTS_BODY", "utf8");

    const bundle = await loadMemory(root, { home });
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.filename).toBe("CLAUDE.md");
    expect(bundle.system).toContain("CLAUDE_BODY");
    expect(bundle.system).not.toContain("AGENTS_BODY");
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

  describe("auto layer", () => {
    it("loads the auto index after the project layer, tagged with baseDir", async () => {
      await writeFile(join(root, "NOVA.md"), "project-nova content", "utf8");
      const autoDir = join(root, ".nova", "memory");
      await writeFileEnsuringDir(join(autoDir, "MEMORY.md"), "AUTO_INDEX_BODY");

      const bundle = await loadMemory(root, { home, autoDir });

      expect(bundle.sources.map((s) => s.layer)).toEqual(["project", "auto"]);
      expect(bundle.autoDir).toBe(autoDir);
      expect(bundle.system).toContain("AUTO_INDEX_BODY");
      expect(bundle.system).toContain(`<memory layer="auto" baseDir="${autoDir}">`);
      // Auto section comes last so it reads as the most-specific override.
      expect(bundle.system.indexOf("AUTO_INDEX_BODY")).toBeGreaterThan(
        bundle.system.indexOf("project-nova content"),
      );
    });

    it("echoes autoDir even when no index file exists yet", async () => {
      const autoDir = join(root, ".nova", "memory");

      const bundle = await loadMemory(root, { home, autoDir });

      // Feature is enabled (dir echoed) but nothing is loaded as a source.
      expect(bundle.autoDir).toBe(autoDir);
      expect(bundle.sources.some((s) => s.layer === "auto")).toBe(false);
      expect(bundle.system).not.toContain('layer="auto"');
    });

    it("leaves autoDir unset when the option is absent", async () => {
      const bundle = await loadMemory(root, { home });
      expect(bundle.autoDir).toBeUndefined();
    });

    it("caps the index to its NEWEST maxEntries (appended last), keeping the heading", async () => {
      const autoDir = join(root, ".nova", "memory");
      // Entries appended oldest→newest, so mem-19 is the most recent (bottom).
      const entries = Array.from({ length: 20 }, (_, i) => `- [Mem ${i}](mem-${i}.md) — hook ${i}`);
      const body = ["# Memory Index", "", ...entries].join("\n");
      await writeFileEnsuringDir(join(autoDir, "MEMORY.md"), body);

      const bundle = await loadMemory(root, { home, autoDir, autoMaxEntries: 3 });

      // Heading + newest 3 entries (17,18,19) kept; oldest 17 dropped.
      expect(bundle.system).toContain("# Memory Index");
      expect(bundle.system).toContain("- [Mem 17](mem-17.md)");
      expect(bundle.system).toContain("- [Mem 19](mem-19.md)");
      expect(bundle.system).not.toContain("- [Mem 16](mem-16.md)");
      expect(bundle.system).not.toContain("- [Mem 0](mem-0.md)");
      expect(bundle.system).toContain("17 older memories omitted");
      expect(bundle.system).toContain("read MEMORY.md for the full index");
      // The truncation notice sits above the surviving entries (where the cut was).
      expect(bundle.system.indexOf("17 older memories omitted")).toBeLessThan(
        bundle.system.indexOf("- [Mem 17](mem-17.md)"),
      );
    });

    it("leaves a within-budget index untouched (no truncation marker)", async () => {
      const autoDir = join(root, ".nova", "memory");
      await writeFileEnsuringDir(
        join(autoDir, "MEMORY.md"),
        "# Memory Index\n\n- [One](one.md) — only entry",
      );

      const bundle = await loadMemory(root, { home, autoDir, autoMaxEntries: 100 });

      expect(bundle.system).toContain("- [One](one.md) — only entry");
      expect(bundle.system).not.toMatch(/omitted to bound the prompt/);
    });
  });
});
