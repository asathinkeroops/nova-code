import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpManager } from "./client.js";
import { mcpToolName, mcpToolToHandler, parseMcpToolName } from "./tool.js";
import type { McpServerSpec } from "./types.js";

/** A fresh in-memory MCP server exposing an `echo` tool and a `boom` tool. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  server.tool(
    "echo",
    "Echo back the provided text.",
    { text: z.string() },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.tool("boom", "Always fails.", {}, async () => ({
    content: [{ type: "text", text: "kaboom" }],
    isError: true,
  }));
  return server;
}

/** Wire a manager to an in-memory linked pair backed by `buildServer()`. */
function managerWithServer(specName = "demo"): {
  manager: McpManager;
  spec: McpServerSpec;
} {
  const spec: McpServerSpec = { type: "stdio", command: "unused" };
  const manager = new McpManager(
    { [specName]: spec },
    {
      createTransport: () => {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        const server = buildServer();
        void server.connect(serverT);
        return clientT;
      },
    },
  );
  return { manager, spec };
}

describe("mcp tool naming", () => {
  it("namespaces and round-trips", () => {
    expect(mcpToolName("git", "status")).toBe("mcp__git__status");
    expect(parseMcpToolName("mcp__git__status")).toEqual({ server: "git", tool: "status" });
  });

  it("preserves __ inside the tool name", () => {
    expect(parseMcpToolName("mcp__srv__a__b")).toEqual({ server: "srv", tool: "a__b" });
  });

  it("rejects non-mcp names", () => {
    expect(parseMcpToolName("read")).toBeNull();
    expect(parseMcpToolName("mcp__only")).toBeNull();
  });
});

describe("mcpToolToHandler", () => {
  it("carries native JSON schema and tags the server", () => {
    const handler = mcpToolToHandler(
      "git",
      { name: "status", description: "show status", inputSchema: { type: "object", properties: { porcelain: { type: "boolean" } } } },
      async () => ({ output: "ok", isError: false }),
    );
    expect(handler.definition.name).toBe("mcp__git__status");
    expect(handler.definition.description).toContain("[MCP:git]");
    expect(handler.definition.inputJsonSchema).toEqual({
      type: "object",
      properties: { porcelain: { type: "boolean" } },
    });
  });

  it("falls back to a valid object schema when none is provided", () => {
    const handler = mcpToolToHandler("x", { name: "t" }, async () => ({ output: "", isError: false }));
    expect(handler.definition.inputJsonSchema).toEqual({ type: "object", properties: {} });
  });
});

describe("McpManager", () => {
  it("connects, bridges tools, and calls them", async () => {
    const { manager } = managerWithServer("demo");
    await manager.connectAll();

    const handlers = manager.handlers();
    const names = handlers.map((h) => h.definition.name).sort();
    expect(names).toEqual(["mcp__demo__boom", "mcp__demo__echo"]);

    const echo = handlers.find((h) => h.definition.name === "mcp__demo__echo")!;
    const res = await echo.run({ text: "hello" }, { cwd: process.cwd() });
    expect(res.output).toBe("hello");
    expect(res.isError).toBeFalsy();

    await manager.close();
  });

  it("surfaces tool-reported errors as isError results", async () => {
    const { manager } = managerWithServer();
    await manager.connectAll();
    const boom = manager.handlers().find((h) => h.definition.name.endsWith("__boom"))!;
    const res = await boom.run({}, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.output).toBe("kaboom");
    await manager.close();
  });

  it("reports status and isolates a failing server", async () => {
    const spec: McpServerSpec = { type: "stdio", command: "unused" };
    const manager = new McpManager(
      { good: spec, bad: spec },
      {
        createTransport: (name) => {
          if (name === "bad") throw new Error("nope");
          const [clientT, serverT] = InMemoryTransport.createLinkedPair();
          void buildServer().connect(serverT);
          return clientT;
        },
      },
    );
    await manager.connectAll();

    const status = manager.status().sort((a, b) => a.name.localeCompare(b.name));
    expect(status.map((s) => [s.name, s.state])).toEqual([
      ["bad", "failed"],
      ["good", "connected"],
    ]);
    expect(status.find((s) => s.name === "bad")?.error).toContain("nope");
    expect(manager.connectedCount).toBe(1);
    // The healthy server's tools are still available.
    expect(manager.handlers().length).toBe(2);

    await manager.close();
  });
});
