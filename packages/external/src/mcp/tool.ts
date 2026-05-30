import { z } from "zod";
import type { ToolHandler } from "@nova/core";

/** Namespace separator for bridged MCP tool names: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp";

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}__${server}__${tool}`;
}

/** Parse a bridged name back into its parts, or null if it isn't one. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== MCP_TOOL_PREFIX) return null;
  const server = parts[1] ?? "";
  const tool = parts.slice(2).join("__");
  if (!server || !tool) return null;
  return { server, tool };
}

/**
 * The MCP tool descriptor as returned by `client.listTools()`. `inputSchema` is
 * native JSON Schema (object type) which we hand to the model verbatim via
 * `ToolDefinition.inputJsonSchema`.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Invokes the underlying MCP tool and returns a Nova tool result. */
export type McpToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ output: string; isError: boolean }>;

// Validation is intentionally permissive: the MCP server is the authority on
// its own schema and rejects bad input with a tool error. A strict zod mirror
// would only risk diverging from the server's real contract.
const passthroughInput = z.record(z.unknown());

/**
 * Ensure the schema handed to the model is a well-formed object schema. MCP
 * guarantees `type: "object"`, but a defensive fallback keeps a malformed or
 * absent schema from producing an invalid `input_schema` on the wire.
 */
function normalizeInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || schema.type !== "object") {
    return { type: "object", properties: {} };
  }
  return { properties: {}, ...schema };
}

/**
 * Bridge a single MCP tool descriptor into a Nova `ToolHandler`. The handler's
 * name is namespaced (`mcp__<server>__<tool>`) to avoid collisions across
 * servers and with builtins; its description is tagged with the origin server
 * so the model knows where the capability comes from.
 */
export function mcpToolToHandler(
  serverName: string,
  descriptor: McpToolDescriptor,
  call: McpToolCaller,
): ToolHandler {
  const description = descriptor.description?.trim()
    ? `[MCP:${serverName}] ${descriptor.description.trim()}`
    : `[MCP:${serverName}] tool "${descriptor.name}" (no description provided)`;

  return {
    definition: {
      name: mcpToolName(serverName, descriptor.name),
      description,
      inputSchema: passthroughInput,
      inputJsonSchema: normalizeInputSchema(descriptor.inputSchema),
    },
    async run(input) {
      const args =
        input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      return call(descriptor.name, args);
    },
  };
}
