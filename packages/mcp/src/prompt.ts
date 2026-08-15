import type { SlashArgSpec, SlashCommand } from "@nova/runtime";
import { MCP_TOOL_PREFIX } from "./tool.js";

/**
 * The MCP prompt descriptor as returned by `client.listPrompts()`. Arguments are
 * a flat list of named parameters; the server fills the prompt template from them
 * when `prompts/get` is called.
 */
export interface McpPromptDescriptor {
  name: string;
  description?: string;
  title?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** Resolves a prompt's filled-in text via `prompts/get`, or an error message. */
export type McpPromptGetter = (
  promptName: string,
  args: Record<string, string>,
) => Promise<{ ok: string } | { error: string }>;

/** Namespaced slash-command name for a bridged prompt: `mcp__<server>__<prompt>`. */
export function mcpPromptName(server: string, prompt: string): string {
  return `${MCP_TOOL_PREFIX}__${server}__${prompt}`;
}

function toArgSpecs(descriptor: McpPromptDescriptor): SlashArgSpec[] {
  return (descriptor.arguments ?? []).map((a) => ({
    name: a.name,
    ...(a.required ? { required: true } : {}),
  }));
}

/**
 * Split a raw arg string into the prompt's declared parameters positionally,
 * the last parameter absorbing the remainder so quoting isn't required. Mirrors
 * the file-command placeholder binding in slash.ts. Returns an error when a
 * `required` parameter is left unfilled.
 */
export function bindPromptArgs(
  specs: SlashArgSpec[],
  rawArgs: string,
): { ok: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  const trimmed = rawArgs.trim();
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (!spec) continue;
    if (i === specs.length - 1 && tokens.length > i) {
      values[spec.name] = tokens.slice(i).join(" ");
    } else if (i < tokens.length) {
      values[spec.name] = tokens[i] as string;
    } else if (spec.required) {
      return { error: `missing required argument "${spec.name}"` };
    }
  }
  return { ok: values };
}

/**
 * Bridge a single MCP prompt descriptor into a Nova slash command. The command
 * name is namespaced (`mcp__<server>__<prompt>`); invoking it resolves the
 * prompt template through `prompts/get` and feeds the rendered text back into
 * the conversation as a user turn.
 */
export function mcpPromptToSlash(
  serverName: string,
  descriptor: McpPromptDescriptor,
  get: McpPromptGetter,
): SlashCommand {
  const specs = toArgSpecs(descriptor);
  const description = descriptor.description?.trim()
    ? `[MCP:${serverName}] ${descriptor.description.trim()}`
    : `[MCP:${serverName}] prompt "${descriptor.name}"`;
  return {
    name: mcpPromptName(serverName, descriptor.name),
    description,
    ...(specs.length > 0
      ? { argHint: specs.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ") }
      : {}),
    source: { kind: "mcp" },
    args: specs,
    run: async (_ctx, args) => {
      const bound = bindPromptArgs(specs, args);
      if ("error" in bound) return { kind: "error", message: bound.error };
      const res = await get(descriptor.name, bound.ok);
      if ("error" in res) return { kind: "error", message: res.error };
      return { kind: "prompt", text: res.ok };
    },
  };
}

/** Flatten a `prompts/get` result's messages into a single prompt string. */
export function formatPromptMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as { content?: unknown }).content;
    if (!content || typeof content !== "object") continue;
    const c = content as Record<string, unknown>;
    if (c.type === "text" && typeof c.text === "string") {
      parts.push(c.text);
    } else if ((c.type === "image" || c.type === "audio") && typeof c.mimeType === "string") {
      parts.push(`[${String(c.type)} ${c.mimeType}]`);
    } else if (c.type === "resource" && c.resource && typeof c.resource === "object") {
      const r = c.resource as Record<string, unknown>;
      if (typeof r.text === "string") parts.push(r.text);
      else parts.push(`[resource ${String(r.uri ?? "")}]`);
    } else if (c.type === "resource_link") {
      parts.push(`[resource_link ${String(c.uri ?? "")}]`);
    }
  }
  return parts.join("\n");
}
