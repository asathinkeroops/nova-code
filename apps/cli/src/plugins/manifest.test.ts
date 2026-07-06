import { describe, expect, it } from "vitest";
import { asPathList, pluginManifestSchema } from "./manifest.js";

describe("pluginManifestSchema", () => {
  it("accepts a minimal manifest", () => {
    const m = pluginManifestSchema.parse({ name: "my-plugin" });
    expect(m.name).toBe("my-plugin");
  });

  it("rejects a non-kebab-case name", () => {
    expect(() => pluginManifestSchema.parse({ name: "MyPlugin" })).toThrow();
    expect(() => pluginManifestSchema.parse({ name: "1plugin" })).toThrow();
    expect(() => pluginManifestSchema.parse({ name: "my_plugin" })).toThrow();
  });

  it("preserves unknown fields (Claude Code compatibility)", () => {
    const m = pluginManifestSchema.parse({
      name: "cc-plugin",
      category: "productivity",
      monitors: "./monitors",
      lspServers: { ts: {} },
    }) as Record<string, unknown>;
    expect(m.category).toBe("productivity");
    expect(m.monitors).toBe("./monitors");
    expect(m.lspServers).toEqual({ ts: {} });
  });

  it("accepts a string or object author", () => {
    expect(pluginManifestSchema.parse({ name: "p", author: "Jane" }).author).toBe("Jane");
    expect(pluginManifestSchema.parse({ name: "p", author: { name: "Jane" } }).author).toEqual({
      name: "Jane",
    });
  });

  it("accepts component paths as string or array", () => {
    expect(pluginManifestSchema.parse({ name: "p", commands: "./cmds" }).commands).toBe("./cmds");
    expect(pluginManifestSchema.parse({ name: "p", agents: ["a", "b"] }).agents).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("asPathList", () => {
  it("normalizes undefined / string / array", () => {
    expect(asPathList(undefined)).toEqual([]);
    expect(asPathList("one")).toEqual(["one"]);
    expect(asPathList(["a", "b"])).toEqual(["a", "b"]);
  });
});
