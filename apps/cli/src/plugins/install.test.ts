import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPlugin, resolvePluginSource, uninstallPlugin } from "./install.js";

describe("resolvePluginSource", () => {
  it("classifies paths, git urls, and github slugs", () => {
    expect(resolvePluginSource("./my-plugin")).toEqual({ source: "path", path: "./my-plugin" });
    expect(resolvePluginSource("/abs/p")).toEqual({ source: "path", path: "/abs/p" });
    expect(resolvePluginSource("~/p")).toEqual({ source: "path", path: "~/p" });
    expect(resolvePluginSource("https://gitlab.com/t/p.git")).toEqual({
      source: "git",
      url: "https://gitlab.com/t/p.git",
    });
    expect(resolvePluginSource("owner/repo")).toEqual({ source: "github", repo: "owner/repo" });
    expect(resolvePluginSource("github:owner/repo#v2")).toEqual({
      source: "github",
      repo: "owner/repo",
      ref: "v2",
    });
  });
});

describe("installPlugin / uninstallPlugin (local path)", () => {
  let src: string;
  let cacheDir: string;

  beforeEach(async () => {
    src = await mkdtemp(join(tmpdir(), "plugin-src-"));
    cacheDir = await mkdtemp(join(tmpdir(), "plugin-cache-"));
  });

  afterEach(async () => {
    await rm(src, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("copies a local plugin into the cache under its manifest name", async () => {
    await mkdir(join(src, ".nova-plugin"), { recursive: true });
    await writeFile(join(src, ".nova-plugin/plugin.json"), JSON.stringify({ name: "my-tool" }));
    await mkdir(join(src, "commands"), { recursive: true });
    await writeFile(join(src, "commands/go.md"), "---\ndescription: go\n---\nrun");

    const result = await installPlugin(src, { cacheDir });
    expect(result.name).toBe("my-tool");
    expect(result.dir).toBe(join(cacheDir, "my-tool"));
    expect((await stat(join(cacheDir, "my-tool", "commands/go.md"))).isFile()).toBe(true);

    await uninstallPlugin("my-tool", { cacheDir });
    await expect(stat(join(cacheDir, "my-tool"))).rejects.toThrow();
  });

  it("rejects a source directory without a manifest", async () => {
    await expect(installPlugin(src, { cacheDir })).rejects.toThrow(/no plugin manifest/);
  });
});
