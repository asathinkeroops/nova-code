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
  /**
   * OAuth 2.0 (authorization-code + PKCE) config for servers that gate access
   * behind a 401. Presence enables the flow; the host attaches an
   * `OAuthClientProvider` for this server when building the transport. Omit (or
   * use static `headers`) for unauthenticated or bearer-token servers.
   */
  oauth?: McpOAuthSpec;
}

export interface McpOAuthSpec {
  /** Space-delimited scopes to request, if the server needs specific ones. */
  scope?: string;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

/** Minimal logger surface — structurally compatible with @nova/runtime's Logger. */
export interface McpLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export type McpServerState = "connected" | "failed" | "disabled" | "needs-auth";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  /** Transport kind, for display. */
  transport: "stdio" | "http" | "sse";
  /** Number of tools the server exposed (0 unless connected). */
  toolCount: number;
  /** Bridged tool names (`mcp__<server>__<tool>`), present when connected. */
  toolNames: string[];
  /** Number of prompts the server exposed (0 unless connected/capable). */
  promptCount: number;
  /** Bridged prompt slash-command names (`mcp__<server>__<prompt>`). */
  promptNames: string[];
  /** Number of static resources + resource templates the server exposed. */
  resourceCount: number;
  /** Failure reason when `state === "failed"`. */
  error?: string;
}
