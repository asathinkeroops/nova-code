/**
 * Transport-agnostic server specs consumed by the MCP manager. These mirror the
 * shape of `settings.mcp.servers[*]` (see @nova/runtime config) minus the
 * `enabled` flag, but are declared here so this module stays decoupled from the
 * settings schema — the CLI maps validated config onto these.
 */

export interface McpStdioServerSpec {
  type?: "stdio";
  /** Executable to spawn (looked up on PATH). */
  command: string;
  args?: string[];
  /** Extra env vars merged over the SDK's safe default environment. */
  env?: Record<string, string>;
  /** Working directory for the subprocess. */
  cwd?: string;
}

export interface McpHttpServerSpec {
  type: "http" | "sse";
  /** Absolute endpoint URL. */
  url: string;
  /** Extra headers sent on every request (auth tokens, etc.). */
  headers?: Record<string, string>;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

/** Minimal logger surface — structurally compatible with @nova/runtime's Logger. */
export interface McpLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export type McpServerState = "connected" | "failed" | "disabled";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  /** Transport kind, for display. */
  transport: "stdio" | "http" | "sse";
  /** Number of tools the server exposed (0 unless connected). */
  toolCount: number;
  /** Bridged tool names (`mcp__<server>__<tool>`), present when connected. */
  toolNames: string[];
  /** Failure reason when `state === "failed"`. */
  error?: string;
}
