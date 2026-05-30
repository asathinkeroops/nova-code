import { McpManager, type McpServerSpec } from "@nova/external";
import type { Logger, Settings } from "@nova/runtime";

/**
 * Map validated `settings.mcp.servers` onto transport-agnostic specs, dropping
 * disabled servers and the `enabled` flag itself. Returns null when MCP is
 * turned off or no server is enabled, so the caller can skip the whole
 * subsystem (no manager, no connect, no shutdown).
 */
export function buildMcpManager(settings: Settings, logger: Logger): McpManager | null {
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
      };
    }
  }
  if (Object.keys(specs).length === 0) return null;
  return new McpManager(specs, { logger, timeoutMs: settings.mcp.timeoutMs });
}
