import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpHttpServerSpec } from "./types.js";

/**
 * Build an HTTP transport for a remote MCP server. `type: "http"` uses the
 * modern Streamable HTTP transport; `type: "sse"` uses the legacy
 * Server-Sent-Events transport. Custom headers (auth tokens, etc.) are attached
 * to every request via `requestInit`.
 *
 * When `authProvider` is supplied the transport drives the OAuth flow itself:
 * it attaches the provider's access token, refreshes it on expiry, and — when
 * no valid token exists and the server demands auth — invokes the provider's
 * `redirectToAuthorization` and throws `UnauthorizedError` from `connect`.
 */
export function createHttpTransport(
  spec: McpHttpServerSpec,
  authProvider?: OAuthClientProvider,
): Transport {
  const url = new URL(spec.url);
  const requestInit = spec.headers ? { headers: spec.headers } : undefined;
  const opts = {
    ...(requestInit ? { requestInit } : {}),
    ...(authProvider ? { authProvider } : {}),
  };
  return spec.type === "sse"
    ? new SSEClientTransport(url, opts)
    : new StreamableHTTPClientTransport(url, opts);
}
