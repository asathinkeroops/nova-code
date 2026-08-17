import { McpManager, type McpServerSpec } from "@nova/mcp";
import type { Logger, Settings } from "@nova/base";
import { makeAuthProviderFactory } from "./mcp-oauth.js";

/**
 * Map validated `settings.mcp.servers` onto transport-agnostic specs, dropping
 * disabled servers and the `enabled` flag itself. `extraSpecs` (e.g. plugin
 * `.mcp.json` servers, already namespaced) are merged on top. Returns null when
 * MCP is turned off or no server is enabled, so the caller can skip the whole
 * subsystem (no manager, no connect, no shutdown).
 */
export function buildMcpManager(
  settings: Settings,
  logger: Logger,
  extraSpecs: Record<string, McpServerSpec> = {},
): McpManager | null {
  if (!settings.mcp.enabled) return null;
  const specs: Record<string, McpServerSpec> = {};
  for (const [name, cfg] of Object.entries(settings.mcp.servers)) {
    if (cfg.enabled === false) continue;
    if (cfg.type === "stdio") {
      specs[name] = {
        type: "stdio",
        command: cfg.command,
        args: cfg.args,
        ...(cfg.env ? { env: cfg.env } : {}),
        ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      };
    } else {
      specs[name] = {
        type: cfg.type,
        url: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        ...(cfg.oauth ? { oauth: cfg.oauth } : {}),
      };
    }
  }
  for (const [name, spec] of Object.entries(extraSpecs)) specs[name] = spec;
  if (Object.keys(specs).length === 0) return null;
  return new McpManager(specs, {
    logger,
    timeoutMs: settings.mcp.timeoutMs,
    createAuthProvider: makeAuthProviderFactory(settings),
    autoDetectOAuth: settings.mcp.oauth.autoDetect,
  });
}
