import { describe, expect, it } from "vitest";
import { parseHeaders, parsePairs, readServers, writeServers } from "./mcp-cli.js";

describe("parsePairs", () => {
  it("splits KEY=value on the first '='", () => {
    expect(parsePairs(["FOO=bar", "URL=https://x.com/a=b"], "env var")).toEqual({
      FOO: "bar",
      URL: "https://x.com/a=b",
    });
  });

  it("allows an empty value", () => {
    expect(parsePairs(["EMPTY="], "env var")).toEqual({ EMPTY: "" });
  });

  it("returns {} for undefined", () => {
    expect(parsePairs(undefined, "env var")).toEqual({});
  });

  it("throws when there is no '='", () => {
    expect(() => parsePairs(["BADPAIR"], "env var")).toThrow(/expected KEY=value/);
  });

  it("throws when the key is empty", () => {
    expect(() => parsePairs(["=value"], "env var")).toThrow(/expected KEY=value/);
  });
});

describe("parseHeaders", () => {
  it("splits on the first ':' and trims", () => {
    expect(parseHeaders(["X-Api-Key: abc123", "Authorization: Bearer x:y"])).toEqual({
      "X-Api-Key": "abc123",
      Authorization: "Bearer x:y",
    });
  });

  it("throws on a header with no ':'", () => {
    expect(() => parseHeaders(["nocolon"])).toThrow(/expected "Name: value"/);
  });
});

describe("readServers / writeServers", () => {
  it("reads the nested servers map", () => {
    const raw = { mcp: { servers: { a: { command: "x" } } } };
    expect(readServers(raw)).toEqual({ a: { command: "x" } });
  });

  it("returns {} when mcp or servers is missing or malformed", () => {
    expect(readServers({})).toEqual({});
    expect(readServers({ mcp: {} })).toEqual({});
    expect(readServers({ mcp: { servers: [] } })).toEqual({});
    expect(readServers({ mcp: "nope" })).toEqual({});
  });

  it("splices servers back in without clobbering sibling keys", () => {
    const raw = {
      model: "deepseek-v4",
      mcp: { enabled: true, timeoutMs: 1000, servers: { old: { command: "y" } } },
    };
    const next = writeServers(raw, { new: { command: "z" } });
    expect(next).toEqual({
      model: "deepseek-v4",
      mcp: { enabled: true, timeoutMs: 1000, servers: { new: { command: "z" } } },
    });
    // original is not mutated
    expect(raw.mcp.servers).toEqual({ old: { command: "y" } });
  });

  it("creates mcp when the config has no mcp key", () => {
    expect(writeServers({ apiKey: "sk" }, { a: { command: "c" } })).toEqual({
      apiKey: "sk",
      mcp: { servers: { a: { command: "c" } } },
    });
  });

  it("round-trips through read after write", () => {
    const written = writeServers({}, { s: { type: "http", url: "https://x/y" } });
    expect(readServers(written)).toEqual({ s: { type: "http", url: "https://x/y" } });
  });
});
