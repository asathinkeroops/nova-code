import { z } from "zod";

/**
 * Plugin manifests live at `.nova-plugin/plugin.json` (preferred) or
 * `.claude-plugin/plugin.json` (fallback). The two are never merged — the
 * higher-priority file wins outright, mirroring how memory files layer
 * (NOVA.md > CLAUDE.md).
 */
export const MANIFEST_DIRS = [".nova-plugin", ".claude-plugin"] as const;
export const MANIFEST_FILE = "plugin.json";

const authorSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

/** A relative path (or list of paths) overriding a component's conventional dir. */
const componentPath = z.union([z.string().min(1), z.array(z.string().min(1))]);

/**
 * A plugin manifest. Claude-Code-compatible: unknown fields (`category`,
 * `monitors`, `lspServers`, …) are preserved via `.passthrough()` and ignored
 * rather than rejected, so a stock Claude Code plugin validates unchanged.
 *
 * The component fields are OPTIONAL path overrides; when omitted the loader
 * falls back to the conventional directory / file names (`commands/`, `agents/`,
 * `skills/`, `hooks/hooks.json`, `.mcp.json`).
 */
export const pluginManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, "plugin name must be kebab-case ([a-z][a-z0-9-]*)"),
    version: z.string().min(1).optional(),
    description: z.string().optional(),
    author: z.union([z.string(), authorSchema]).optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    // Component-path overrides (relative to the plugin root).
    commands: componentPath.optional(),
    agents: componentPath.optional(),
    skills: componentPath.optional(),
    hooks: componentPath.optional(),
    lsp: componentPath.optional(),
    // Native tools entry (a `.js` module). Only loaded when
    // settings.plugins.allowNativeCode is true — it executes plugin code.
    tools: componentPath.optional(),
    // MCP: either a path to a JSON file, or an inline `{ "<name>": spec }` map.
    mcpServers: z.union([z.string().min(1), z.record(z.unknown())]).optional(),
  })
  .passthrough();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** Normalize an optional single-or-array component override to a string list. */
export function asPathList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
