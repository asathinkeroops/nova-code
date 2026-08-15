import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpStdioServerSpec } from "./types.js";

/**
 * Build a stdio transport that spawns the configured subprocess. `env` is
 * merged over `getDefaultEnvironment()` (a curated allowlist — PATH, HOME, etc.)
 * rather than the full ambient environment, so secrets aren't leaked to the
 * child unless explicitly listed. The child's stderr is ignored to keep server
 * chatter out of the TUI.
 */
export function createStdioTransport(spec: McpStdioServerSpec): StdioClientTransport {
  const params: StdioServerParameters = {
    command: spec.command,
    args: spec.args ?? [],
    env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
    stderr: "ignore",
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
  };
  return new StdioClientTransport(params);
}
