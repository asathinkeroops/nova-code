import { describe, expect, it } from "vitest";
import { DEFAULT_SERVERS, isCommandAvailable, resolveServers, serverForPath } from "./servers.js";

describe("resolveServers", () => {
  it("returns a copy of the defaults when no overrides are given", () => {
    const r = resolveServers();
    expect(r).toHaveLength(DEFAULT_SERVERS.length);
    expect(r).not.toBe(DEFAULT_SERVERS);
  });

  it("replaces a default with a same-languageId override", () => {
    const r = resolveServers([
      { languageId: "typescript", command: "my-ts-ls", args: ["--stdio"], extensions: ["ts"] },
    ]);
    const ts = r.find((s) => s.languageId === "typescript");
    expect(ts?.command).toBe("my-ts-ls");
    expect(ts?.extensions).toEqual(["ts"]);
  });

  it("appends servers for unknown languageIds", () => {
    const r = resolveServers([
      { languageId: "zig", command: "zls", args: [], extensions: ["zig"] },
    ]);
    expect(r.find((s) => s.languageId === "zig")).toBeDefined();
    expect(r.length).toBe(DEFAULT_SERVERS.length + 1);
  });
});

describe("serverForPath", () => {
  const servers = resolveServers();
  it("maps an extension to its owning server", () => {
    expect(serverForPath(servers, "/a/b/foo.ts")?.languageId).toBe("typescript");
    expect(serverForPath(servers, "main.go")?.languageId).toBe("go");
    expect(serverForPath(servers, "lib.rs")?.languageId).toBe("rust");
  });
  it("is case-insensitive on the extension", () => {
    expect(serverForPath(servers, "Foo.TS")?.languageId).toBe("typescript");
  });
  it("returns undefined for unknown or extensionless paths", () => {
    expect(serverForPath(servers, "README")).toBeUndefined();
    expect(serverForPath(servers, "data.unknownext")).toBeUndefined();
  });
});

describe("isCommandAvailable", () => {
  it("finds a binary that exists on PATH", () => {
    expect(isCommandAvailable("node")).toBe(true);
  });
  it("reports a bogus command as missing", () => {
    expect(isCommandAvailable("definitely-not-a-real-binary-xyz123")).toBe(false);
  });
});
