import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMarketplace, marketplacePluginSource } from "./marketplace.js";

describe("loadMarketplace / marketplacePluginSource (local path)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "market-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeJson(rel: string, value: unknown): Promise<void> {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, JSON.stringify(value), "utf8");
  }

  it("parses a catalog and resolves a relative plugin source against the root", async () => {
    await writeJson(".nova-plugin/marketplace.json", {
      name: "acme",
      owner: { name: "Acme" },
      plugins: [
        { name: "formatter", source: "./plugins/formatter", description: "fmt" },
        { name: "linter", source: { source: "github", repo: "acme/linter" } },
      ],
    });

    const { catalog, root: mRoot } = await loadMarketplace("acme", { source: "path", path: root });
    expect(catalog.name).toBe("acme");
    expect(catalog.plugins).toHaveLength(2);

    // Relative string source → absolute path under the marketplace root.
    expect(marketplacePluginSource(catalog, mRoot, "formatter")).toEqual({
      source: "path",
      path: join(root, "plugins/formatter"),
    });
    // Explicit github source passes through verbatim.
    expect(marketplacePluginSource(catalog, mRoot, "linter")).toEqual({
      source: "github",
      repo: "acme/linter",
    });
  });

  it("honors metadata.pluginRoot when resolving relative sources", async () => {
    await writeJson(".nova-plugin/marketplace.json", {
      name: "acme",
      metadata: { pluginRoot: "./packages" },
      plugins: [{ name: "tool", source: "tool" }],
    });
    const { catalog, root: mRoot } = await loadMarketplace("acme", { source: "path", path: root });
    expect(marketplacePluginSource(catalog, mRoot, "tool")).toEqual({
      source: "path",
      path: join(root, "packages/tool"),
    });
  });

  it("falls back to .claude-plugin/marketplace.json (Claude Code compat)", async () => {
    await writeJson(".claude-plugin/marketplace.json", {
      name: "cc",
      plugins: [{ name: "p" }],
    });
    const { catalog, root: mRoot } = await loadMarketplace("cc", { source: "path", path: root });
    expect(catalog.name).toBe("cc");
    // Missing source defaults to <root>/<name>.
    expect(marketplacePluginSource(catalog, mRoot, "p")).toEqual({
      source: "path",
      path: join(root, "p"),
    });
  });

  it("throws for an unknown plugin name", async () => {
    await writeJson(".nova-plugin/marketplace.json", { name: "acme", plugins: [] });
    const { catalog, root: mRoot } = await loadMarketplace("acme", { source: "path", path: root });
    expect(() => marketplacePluginSource(catalog, mRoot, "nope")).toThrow(/not found/);
  });
});
