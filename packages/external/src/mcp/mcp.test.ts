import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpManager } from "./client.js";
import { mcpToolName, mcpToolToHandler, parseMcpToolName } from "./tool.js";
import { bindPromptArgs, formatPromptMessages, mcpPromptName } from "./prompt.js";
import { MCP_LIST_RESOURCES_TOOL, MCP_READ_RESOURCE_TOOL } from "./resource.js";
import type { McpServerSpec } from "./types.js";

/**
 * A fresh in-memory MCP server exposing an `echo` tool and a `boom` tool, plus
 * (when `extras` is set) a prompt and a resource so prompt/resource bridging can
 * be exercised against a real handshake.
 */
function buildServer(extras = false): McpServer {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  server.tool("echo", "Echo back the provided text.", { text: z.string() }, async ({ text }) => ({
    content: [{ type: "text", text }],
  }));
  server.tool("boom", "Always fails.", {}, async () => ({
    content: [{ type: "text", text: "kaboom" }],
    isError: true,
  }));
  if (extras) {
    server.prompt(
      "greet",
      "Greet someone by name.",
      { who: z.string() },
      ({ who }) => ({
        messages: [
          { role: "user", content: { type: "text", text: `Say hello to ${who}.` } },
        ],
      }),
    );
    server.resource("readme", "file:///readme.md", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Hello from MCP" }],
    }));
  }
  return server;
}

/** Wire a manager to an in-memory linked pair backed by `buildServer()`. */
function managerWithServer(specName = "demo", extras = false): {
  manager: McpManager;
  spec: McpServerSpec;
} {
  const spec: McpServerSpec = { type: "stdio", command: "unused" };
  const manager = new McpManager(
    { [specName]: spec },
    {
      createTransport: () => {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        const server = buildServer(extras);
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

  it("rejects a name with an empty server or tool segment", () => {
    expect(parseMcpToolName("mcp____tool")).toBeNull();
    expect(parseMcpToolName("mcp__srv__")).toBeNull();
  });
});

describe("mcpToolToHandler", () => {
  it("carries native JSON schema and tags the server", () => {
    const handler = mcpToolToHandler(
      "git",
      {
        name: "status",
        description: "show status",
        inputSchema: { type: "object", properties: { porcelain: { type: "boolean" } } },
      },
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
    const handler = mcpToolToHandler("x", { name: "t" }, async () => ({
      output: "",
      isError: false,
    }));
    expect(handler.definition.inputJsonSchema).toEqual({ type: "object", properties: {} });
  });

  it("synthesizes a description when the server provides none", () => {
    const handler = mcpToolToHandler("git", { name: "status" }, async () => ({
      output: "",
      isError: false,
    }));
    expect(handler.definition.description).toBe(
      '[MCP:git] tool "status" (no description provided)',
    );
  });

  it("replaces a non-object schema with the object fallback", () => {
    const handler = mcpToolToHandler(
      "x",
      { name: "t", inputSchema: { type: "string" } },
      async () => ({ output: "", isError: false }),
    );
    expect(handler.definition.inputJsonSchema).toEqual({ type: "object", properties: {} });
  });

  it("backfills an empty properties bag while preserving the rest of the schema", () => {
    const handler = mcpToolToHandler(
      "x",
      { name: "t", inputSchema: { type: "object", required: ["a"] } },
      async () => ({ output: "", isError: false }),
    );
    expect(handler.definition.inputJsonSchema).toEqual({
      type: "object",
      properties: {},
      required: ["a"],
    });
  });

  it("coerces a non-object tool input to an empty args object", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const handler = mcpToolToHandler("x", { name: "t" }, async (_name, args) => {
      calls.push(args);
      return { output: "ok", isError: false };
    });
    await handler.run(null as unknown as Record<string, unknown>, { cwd: process.cwd() });
    expect(calls[0]).toEqual({});
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

  it("bridges prompts as namespaced slash commands and resolves them", async () => {
    const { manager } = managerWithServer("demo", true);
    await manager.connectAll();

    const prompts = manager.promptCommands();
    expect(prompts.map((p) => p.name)).toEqual([mcpPromptName("demo", "greet")]);
    const greet = prompts[0]!;
    expect(greet.source.kind).toBe("mcp");
    expect(greet.argHint).toBe("<who>");

    const outcome = await greet.run({ cwd: process.cwd() }, "World");
    expect(outcome).toEqual({ kind: "prompt", text: "Say hello to World." });

    await manager.close();
  });

  it("errors a prompt invocation that omits a required argument", async () => {
    const { manager } = managerWithServer("demo", true);
    await manager.connectAll();
    const greet = manager.promptCommands()[0]!;
    const outcome = await greet.run({ cwd: process.cwd() }, "");
    expect(outcome.kind).toBe("error");
    await manager.close();
  });

  it("exposes resource tools that list and read", async () => {
    const { manager } = managerWithServer("demo", true);
    await manager.connectAll();

    const tools = manager.resourceTools();
    expect(tools.map((t) => t.definition.name).sort()).toEqual([
      MCP_LIST_RESOURCES_TOOL,
      MCP_READ_RESOURCE_TOOL,
    ]);

    const list = tools.find((t) => t.definition.name === MCP_LIST_RESOURCES_TOOL)!;
    const listed = await list.run({}, { cwd: process.cwd() });
    expect(listed.isError).toBeFalsy();
    expect(listed.output).toContain("file:///readme.md");

    const read = tools.find((t) => t.definition.name === MCP_READ_RESOURCE_TOOL)!;
    const got = await read.run({ uri: "file:///readme.md" }, { cwd: process.cwd() });
    expect(got.isError).toBeFalsy();
    expect(got.output).toContain("# Hello from MCP");

    const missing = await read.run({ uri: "file:///nope.md" }, { cwd: process.cwd() });
    expect(missing.isError).toBe(true);

    await manager.close();
  });

  it("exposes no prompt commands or resource tools for a tools-only server", async () => {
    const { manager } = managerWithServer("demo", false);
    await manager.connectAll();
    expect(manager.promptCommands()).toEqual([]);
    expect(manager.resourceTools()).toEqual([]);
    const [status] = manager.status();
    expect(status?.promptCount).toBe(0);
    expect(status?.resourceCount).toBe(0);
    await manager.close();
  });

  it("reports prompt and resource counts in status", async () => {
    const { manager } = managerWithServer("demo", true);
    await manager.connectAll();
    const [status] = manager.status();
    expect(status?.promptCount).toBe(1);
    expect(status?.promptNames).toEqual([mcpPromptName("demo", "greet")]);
    expect(status?.resourceCount).toBe(1);
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

describe("bindPromptArgs", () => {
  it("binds positional tokens, last param absorbing the remainder", () => {
    const specs = [{ name: "a" }, { name: "b" }];
    expect(bindPromptArgs(specs, "one two three")).toEqual({ ok: { a: "one", b: "two three" } });
  });

  it("errors on a missing required argument", () => {
    const out = bindPromptArgs([{ name: "a", required: true }], "");
    expect(out).toHaveProperty("error");
  });

  it("leaves an optional argument unset when absent", () => {
    expect(bindPromptArgs([{ name: "a" }], "")).toEqual({ ok: {} });
  });
});

describe("formatPromptMessages", () => {
  it("flattens text content across messages", () => {
    const messages = [
      { role: "user", content: { type: "text", text: "first" } },
      { role: "assistant", content: { type: "text", text: "second" } },
    ];
    expect(formatPromptMessages(messages)).toBe("first\nsecond");
  });

  it("renders embedded resource text and placeholders", () => {
    const messages = [
      { role: "user", content: { type: "resource", resource: { uri: "x://1", text: "body" } } },
      { role: "user", content: { type: "image", mimeType: "image/png", data: "..." } },
    ];
    expect(formatPromptMessages(messages)).toBe("body\n[image image/png]");
  });

  it("returns empty string for non-array input", () => {
    expect(formatPromptMessages(undefined)).toBe("");
  });
});
