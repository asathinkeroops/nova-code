import { parseSettings } from "@nova/runtime";
import { describe, expect, it } from "vitest";
import { buildMcpManager } from "./mcp.js";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
  child() {
    return noopLogger;
  },
} as never;

function settingsWith(mcp: unknown) {
  return parseSettings({
    apiKey: "x",
    baseURL: "https://api.anthropic.com",
    model: "claude",
    ...(mcp ? { mcp } : {}),
  });
}

describe("buildMcpManager", () => {
  it("returns null when MCP is disabled", () => {
    const s = settingsWith({ enabled: false, servers: { git: { command: "x" } } });
    expect(buildMcpManager(s, noopLogger)).toBeNull();
  });

  it("returns null when no servers are configured", () => {
    expect(buildMcpManager(settingsWith(undefined), noopLogger)).toBeNull();
  });

  it("maps stdio + http servers and drops disabled ones", () => {
    const s = settingsWith({
      servers: {
        git: { command: "uvx", args: ["mcp-server-git"] },
        remote: { type: "http", url: "https://example.com/mcp", headers: { authorization: "Bearer t" } },
        off: { command: "foo", enabled: false },
      },
    });
    const mgr = buildMcpManager(s, noopLogger);
    expect(mgr).not.toBeNull();
    expect(mgr!.serverCount).toBe(2);
    const status = mgr!.status().sort((a, b) => a.name.localeCompare(b.name));
    expect(status.map((x) => [x.name, x.transport])).toEqual([
      ["git", "stdio"],
      ["remote", "http"],
    ]);
  });

  it("returns null when every server is disabled", () => {
    const s = settingsWith({ servers: { a: { command: "x", enabled: false } } });
    expect(buildMcpManager(s, noopLogger)).toBeNull();
  });
});
