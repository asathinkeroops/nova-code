import { describe, expect, it } from "vitest";
import { classifyInstallSpec } from "./plugin-cli.js";

describe("classifyInstallSpec", () => {
  const markets = { official: { source: "github", repo: "anthropics/x" } };

  it("resolves name@marketplace when the marketplace is registered", () => {
    expect(classifyInstallSpec("my-tool@official", markets)).toEqual({
      kind: "marketplace",
      pluginName: "my-tool",
      market: "official",
    });
  });

  it("treats name@unknown as a direct source", () => {
    expect(classifyInstallSpec("my-tool@nope", markets)).toEqual({ kind: "direct" });
  });

  it("does not misread a git@ url as a marketplace spec", () => {
    expect(classifyInstallSpec("git@github.com:owner/repo.git", markets)).toEqual({
      kind: "direct",
    });
  });

  it("classifies bare sources (path / slug / url) as direct", () => {
    expect(classifyInstallSpec("./local", markets)).toEqual({ kind: "direct" });
    expect(classifyInstallSpec("owner/repo", markets)).toEqual({ kind: "direct" });
    expect(classifyInstallSpec("https://gitlab.com/t/p.git", markets)).toEqual({ kind: "direct" });
  });

  it("splits on the last @ so plugin names may themselves contain one", () => {
    expect(classifyInstallSpec("a@b@official", markets)).toEqual({
      kind: "marketplace",
      pluginName: "a@b",
      market: "official",
    });
  });

  it("ignores a leading @ (index 0) as it leaves no plugin name", () => {
    expect(classifyInstallSpec("@official", markets)).toEqual({ kind: "direct" });
  });
});
