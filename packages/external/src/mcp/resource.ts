import { z } from "zod";
import type { ToolHandler } from "@nova/core";

/** A static resource as returned by `client.listResources()`. */
export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** A resource template as returned by `client.listResourceTemplates()`. */
export interface McpResourceTemplateDescriptor {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** A connected server's advertised resources, grouped for listing. */
export interface McpServerResources {
  server: string;
  resources: McpResourceDescriptor[];
  templates: McpResourceTemplateDescriptor[];
}

/** Lists resources across resource-capable servers, optionally one named server. */
export type McpResourceLister = (server?: string) => McpServerResources[];

/** Reads a resource by URI (optionally constrained to one server). */
export type McpResourceReader = (
  uri: string,
  server: string | undefined,
) => Promise<{ output: string; isError: boolean }>;

/** Global tool name listing every connected server's resources. */
export const MCP_LIST_RESOURCES_TOOL = "mcp_list_resources";
/** Global tool name reading a single resource by URI. */
export const MCP_READ_RESOURCE_TOOL = "mcp_read_resource";

function renderListing(groups: McpServerResources[]): string {
  if (groups.length === 0) return "No MCP servers expose resources.";
  const out: string[] = [];
  for (const g of groups) {
    out.push(`# ${g.server}`);
    if (g.resources.length === 0 && g.templates.length === 0) {
      out.push("  (no resources)");
    }
    for (const r of g.resources) {
      const label = r.name ? ` — ${r.name}` : "";
      const mime = r.mimeType ? ` [${r.mimeType}]` : "";
      out.push(`  ${r.uri}${label}${mime}`);
      if (r.description) out.push(`    ${r.description}`);
    }
    for (const t of g.templates) {
      const label = t.name ? ` — ${t.name}` : "";
      out.push(`  ${t.uriTemplate}${label} (template)`);
      if (t.description) out.push(`    ${t.description}`);
    }
  }
  return out.join("\n");
}

const listInput = z.object({ server: z.string().optional() });
const readInput = z.object({ uri: z.string().min(1), server: z.string().optional() });

/**
 * Two model-facing tools that expose MCP resources, mirroring the way
 * `mcpToolToHandler` bridges MCP tools. Unlike per-server tools, these are
 * global: the model passes a `uri` (and optionally a `server`) so a single pair
 * covers every connected server. Both are read-only.
 */
export function resourceToolHandlers(
  list: McpResourceLister,
  read: McpResourceReader,
): ToolHandler[] {
  return [
    {
      definition: {
        name: MCP_LIST_RESOURCES_TOOL,
        description:
          "[MCP] List resources (and resource templates) exposed by connected MCP servers. " +
          "Optionally pass `server` to list only that server. Returns URIs to pass to " +
          `${MCP_READ_RESOURCE_TOOL}.`,
        inputSchema: listInput,
        inputJsonSchema: {
          type: "object",
          properties: {
            server: { type: "string", description: "Limit the listing to one server by name." },
          },
        },
      },
      async run(input) {
        const { server } = listInput.parse(input ?? {});
        return { output: renderListing(list(server)), isError: false };
      },
    },
    {
      definition: {
        name: MCP_READ_RESOURCE_TOOL,
        description:
          "[MCP] Read the contents of an MCP resource by its URI (from " +
          `${MCP_LIST_RESOURCES_TOOL}). Pass \`server\` to disambiguate when the same URI is ` +
          "served by more than one server.",
        inputSchema: readInput,
        inputJsonSchema: {
          type: "object",
          properties: {
            uri: { type: "string", description: "The resource URI to read." },
            server: { type: "string", description: "The server owning the resource (optional)." },
          },
          required: ["uri"],
        },
      },
      async run(input) {
        const { uri, server } = readInput.parse(input ?? {});
        return read(uri, server);
      },
    },
  ];
}
