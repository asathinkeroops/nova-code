import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolHandler } from "@nova/core";
import { createHttpTransport } from "./http.js";
import { createStdioTransport } from "./stdio.js";
import { mcpToolToHandler, type McpToolDescriptor } from "./tool.js";
import type {
  McpHttpServerSpec,
  McpLogger,
  McpServerSpec,
  McpServerState,
  McpServerStatus,
  McpStdioServerSpec,
} from "./types.js";

function isHttpSpec(spec: McpServerSpec): spec is McpHttpServerSpec {
  return spec.type === "http" || spec.type === "sse";
}

const DEFAULT_CLIENT_INFO = { name: "nova", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 60_000;

/** Build the real transport for a spec. Overridable for tests. */
export function transportForSpec(spec: McpServerSpec): Transport {
  return isHttpSpec(spec) ? createHttpTransport(spec) : createStdioTransport(spec as McpStdioServerSpec);
}

function transportKind(spec: McpServerSpec): "stdio" | "http" | "sse" {
  return !spec.type ? "stdio" : spec.type;
}

/** Flatten an MCP tool-call result's content blocks into a single string. */
function formatContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "image" || b.type === "audio") {
      parts.push(`[${String(b.type)} ${String(b.mimeType ?? "")}]`.trim());
    } else if (b.type === "resource" && b.resource && typeof b.resource === "object") {
      const r = b.resource as Record<string, unknown>;
      if (typeof r.text === "string") parts.push(r.text);
      else parts.push(`[resource ${String(r.uri ?? "")}]`);
    } else if (b.type === "resource_link") {
      parts.push(`[resource_link ${String(b.uri ?? "")}]`);
    }
  }
  return parts.join("\n");
}

export interface McpManagerOptions {
  logger?: McpLogger;
  /** Per-tool-call timeout (ms). */
  timeoutMs?: number;
  /** Identifies this client to servers during the handshake. */
  clientInfo?: { name: string; version: string };
  /** Test seam: override transport construction. */
  createTransport?: (name: string, spec: McpServerSpec) => Transport;
}

interface Connection {
  name: string;
  spec: McpServerSpec;
  client: Client;
  handlers: ToolHandler[];
}

/**
 * Connects to a set of MCP servers and bridges their tools into Nova
 * `ToolHandler`s. Construction is cheap; `connectAll()` does the network/process
 * work. A server that fails to connect or list tools is recorded as `failed`
 * and skipped — one bad server never aborts the others or startup. Call
 * `close()` on shutdown to tear down transports and child processes.
 */
export class McpManager {
  private readonly servers: Array<{ name: string; spec: McpServerSpec }>;
  private readonly opts: McpManagerOptions;
  private readonly connections = new Map<string, Connection>();
  private readonly failures = new Map<string, string>();
  private connected = false;

  constructor(servers: Record<string, McpServerSpec>, opts: McpManagerOptions = {}) {
    this.servers = Object.entries(servers).map(([name, spec]) => ({ name, spec }));
    this.opts = opts;
  }

  /** Connect every configured server in parallel. Resolves once all settle. */
  async connectAll(): Promise<void> {
    this.connected = true;
    await Promise.all(this.servers.map((s) => this.connectOne(s.name, s.spec)));
  }

  private async connectOne(name: string, spec: McpServerSpec): Promise<void> {
    const make = this.opts.createTransport ?? ((_n, s) => transportForSpec(s));
    const client = new Client(this.opts.clientInfo ?? DEFAULT_CLIENT_INFO, {
      capabilities: {},
    });
    try {
      const transport = make(name, spec);
      await client.connect(transport);
      const { tools } = await client.listTools();
      const timeout = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const handlers = (tools as McpToolDescriptor[]).map((descriptor) =>
        mcpToolToHandler(name, descriptor, (toolName, args) =>
          this.invoke(name, client, toolName, args, timeout),
        ),
      );
      this.connections.set(name, { name, spec, client, handlers });
      this.opts.logger?.info(
        { server: name, tools: handlers.length },
        "mcp server connected",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failures.set(name, msg);
      this.opts.logger?.warn({ server: name, err: msg }, "mcp server failed to connect");
      try {
        await client.close();
      } catch {
        // best-effort cleanup of a half-open client
      }
    }
  }

  private async invoke(
    server: string,
    client: Client,
    toolName: string,
    args: Record<string, unknown>,
    timeout: number,
  ): Promise<{ output: string; isError: boolean }> {
    try {
      const res = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout,
      });
      const isError = res.isError === true;
      let output = formatContent((res as { content?: unknown }).content);
      if (!output) {
        const structured = (res as { structuredContent?: unknown }).structuredContent;
        if (structured !== undefined) output = JSON.stringify(structured, null, 2);
      }
      if (!output) output = isError ? "MCP tool returned an error." : "(no content)";
      return { output, isError };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn({ server, tool: toolName, err: msg }, "mcp tool call failed");
      return { output: `MCP tool call failed: ${msg}`, isError: true };
    }
  }

  /** All successfully-bridged tool handlers across every connected server. */
  handlers(): ToolHandler[] {
    const out: ToolHandler[] = [];
    for (const conn of this.connections.values()) out.push(...conn.handlers);
    return out;
  }

  /** True if any server connected and exposed at least one tool. */
  hasTools(): boolean {
    return this.handlers().length > 0;
  }

  /** Per-server connection status for display (`/mcp`). */
  status(): McpServerStatus[] {
    return this.servers.map(({ name, spec }) => {
      const conn = this.connections.get(name);
      const transport = transportKind(spec);
      if (conn) {
        const state: McpServerState = "connected";
        return {
          name,
          state,
          transport,
          toolCount: conn.handlers.length,
          toolNames: conn.handlers.map((h) => h.definition.name),
        };
      }
      const error = this.failures.get(name);
      return {
        name,
        state: "failed" as McpServerState,
        transport,
        toolCount: 0,
        toolNames: [],
        ...(error ? { error } : {}),
      };
    });
  }

  /** Total servers configured (connected + failed). */
  get serverCount(): number {
    return this.servers.length;
  }

  get connectedCount(): number {
    return this.connections.size;
  }

  /** Close every open client. Safe to call before or after connectAll(). */
  async close(): Promise<void> {
    if (!this.connected && this.connections.size === 0) return;
    await Promise.all(
      Array.from(this.connections.values()).map(async (conn) => {
        try {
          await conn.client.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.opts.logger?.warn({ server: conn.name, err: msg }, "mcp close failed");
        }
      }),
    );
    this.connections.clear();
  }
}
