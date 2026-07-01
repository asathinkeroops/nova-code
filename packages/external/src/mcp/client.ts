import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolHandler } from "@nova/core";
import type { SlashCommand } from "../slash.js";
import { createHttpTransport } from "./http.js";
import { createStdioTransport } from "./stdio.js";
import { formatPromptMessages, mcpPromptToSlash, type McpPromptDescriptor } from "./prompt.js";
import {
  resourceToolHandlers,
  type McpResourceDescriptor,
  type McpResourceTemplateDescriptor,
  type McpServerResources,
} from "./resource.js";
import { mcpToolToHandler, type McpToolDescriptor } from "./tool.js";
import type {
  McpHttpServerSpec,
  McpLogger,
  McpServerSpec,
  McpServerState,
  McpServerStatus,
  McpStdioServerSpec,
} from "./types.js";

function isHttpSpec(spec: McpServerSpec): spec is McpHttpServerSpec {
  return spec.type === "http" || spec.type === "sse";
}

const DEFAULT_CLIENT_INFO = { name: "nova", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 60_000;

/** SDK HTTP/SSE transports expose `finishAuth` to complete the OAuth handshake. */
interface AuthCompletableTransport extends Transport {
  finishAuth(authorizationCode: string): Promise<void>;
}

/**
 * A provider whose `redirectToAuthorization` records the URL (rather than
 * opening a browser) so the host can drive the interactive grant.
 * {@link NovaOAuthProvider} implements these; both reads are optional so a host
 * may supply a plainer provider.
 */
interface RedirectAwareProvider extends OAuthClientProvider {
  readonly authorizationUrl?: URL;
  readonly expectedState?: string;
}

function canFinishAuth(t: Transport): t is AuthCompletableTransport {
  return typeof (t as { finishAuth?: unknown }).finishAuth === "function";
}

/** Build the real transport for a spec. Overridable for tests. */
export function transportForSpec(
  spec: McpServerSpec,
  authProvider?: OAuthClientProvider,
): Transport {
  return isHttpSpec(spec)
    ? createHttpTransport(spec, authProvider)
    : createStdioTransport(spec as McpStdioServerSpec);
}

/**
 * Outcome of an interactive {@link McpManager.authorize} attempt.
 * - `connected`: tokens were already valid (or refreshed) and the server is now
 *   live; `handlers`/`prompts`/`resourceTools` are the freshly-bridged surfaces
 *   the host should register into its live registries.
 * - `redirect`: the user must approve in a browser. Open `authorizationUrl`,
 *   capture the redirect's `code` (verifying `expectedState`), then call
 *   `complete(code)` to finish and reconnect.
 * - `error` / `unsupported`: nothing to do.
 */
export type McpAuthResult =
  | {
      status: "connected";
      handlers: ToolHandler[];
      prompts: SlashCommand[];
      resourceTools: ToolHandler[];
    }
  | {
      status: "redirect";
      authorizationUrl: URL;
      expectedState?: string;
      complete: (authorizationCode: string) => Promise<McpAuthResult>;
    }
  | { status: "error"; error: string }
  | { status: "unsupported"; error: string };

function transportKind(spec: McpServerSpec): "stdio" | "http" | "sse" {
  return !spec.type ? "stdio" : spec.type;
}

/** Flatten an MCP tool-call result's content blocks into a single string. */
function formatContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "image" || b.type === "audio") {
      parts.push(`[${String(b.type)} ${String(b.mimeType ?? "")}]`.trim());
    } else if (b.type === "resource" && b.resource && typeof b.resource === "object") {
      const r = b.resource as Record<string, unknown>;
      if (typeof r.text === "string") parts.push(r.text);
      else parts.push(`[resource ${String(r.uri ?? "")}]`);
    } else if (b.type === "resource_link") {
      parts.push(`[resource_link ${String(b.uri ?? "")}]`);
    }
  }
  return parts.join("\n");
}

/** Flatten a `resources/read` result's contents into a single string. */
function formatResourceContents(contents: unknown): string {
  if (!Array.isArray(contents)) return "";
  const parts: string[] = [];
  for (const block of contents) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") {
      parts.push(b.text);
    } else if (typeof b.blob === "string") {
      const mime = typeof b.mimeType === "string" ? b.mimeType : "application/octet-stream";
      parts.push(`[binary resource ${String(b.uri ?? "")} ${mime}, ${b.blob.length} base64 chars]`);
    }
  }
  return parts.join("\n");
}

export interface McpManagerOptions {
  logger?: McpLogger;
  /** Per-tool-call timeout (ms). */
  timeoutMs?: number;
  /** Identifies this client to servers during the handshake. */
  clientInfo?: { name: string; version: string };
  /** Test seam: override transport construction. */
  createTransport?: (
    name: string,
    spec: McpServerSpec,
    authProvider?: OAuthClientProvider,
  ) => Transport;
  /**
   * Build the OAuth provider for a remote server that opted into `oauth`
   * (host-supplied so token storage / redirect URL stay a host concern). Called
   * once per connect attempt; return `undefined` to skip OAuth for the server.
   */
  createAuthProvider?: (
    name: string,
    spec: McpHttpServerSpec,
  ) => Promise<OAuthClientProvider | undefined> | OAuthClientProvider | undefined;
  /**
   * When true, a remote server that challenges with 401/403 is marked
   * `needs-auth` (offering interactive authorization) even without an explicit
   * `oauth` block — mirroring Claude Code. Servers using a static `Authorization`
   * header are excluded. Requires {@link createAuthProvider}. Defaults to false.
   */
  autoDetectOAuth?: boolean;
}

interface Connection {
  name: string;
  spec: McpServerSpec;
  client: Client;
  handlers: ToolHandler[];
  prompts: SlashCommand[];
  resources: McpResourceDescriptor[];
  templates: McpResourceTemplateDescriptor[];
  /** Whether the server advertised the `resources` capability. */
  hasResources: boolean;
}

/**
 * Connects to a set of MCP servers and bridges their tools into Nova
 * `ToolHandler`s. Construction is cheap; `connectAll()` does the network/process
 * work. A server that fails to connect or list tools is recorded as `failed`
 * and skipped — one bad server never aborts the others or startup. Call
 * `close()` on shutdown to tear down transports and child processes.
 */
export class McpManager {
  private readonly servers: Array<{ name: string; spec: McpServerSpec }>;
  private readonly opts: McpManagerOptions;
  private readonly connections = new Map<string, Connection>();
  private readonly failures = new Map<string, string>();
  /** Servers awaiting an interactive `/mcp` Authenticate grant (distinct from failed). */
  private readonly needsAuth = new Set<string>();
  /** Treat a 401 from a remote server as `needs-auth` even without `oauth` config. */
  private readonly autoDetectOAuth: boolean;
  private connected = false;

  constructor(servers: Record<string, McpServerSpec>, opts: McpManagerOptions = {}) {
    this.servers = Object.entries(servers).map(([name, spec]) => ({ name, spec }));
    this.opts = opts;
    this.autoDetectOAuth = opts.autoDetectOAuth ?? false;
  }

  /**
   * Whether OAuth can be attempted for a server: any remote (http/sse) server
   * that either opted in via `oauth` config, or — when {@link autoDetectOAuth}
   * is on — carries no static `Authorization` header (a 401 there would be a bad
   * bearer token, not an OAuth challenge). Gates both the startup 401 → needs-auth
   * reclassification and interactive {@link authorize}.
   */
  private oauthEligible(spec: McpServerSpec): boolean {
    if (!isHttpSpec(spec)) return false;
    if (spec.oauth) return true;
    if (!this.autoDetectOAuth || !this.opts.createAuthProvider) return false;
    const headers = spec.headers ?? {};
    return !Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  }

  /** True if `name` is a configured server for which OAuth can be attempted. */
  isOAuthCapable(name: string): boolean {
    const spec = this.servers.find((s) => s.name === name)?.spec;
    return !!spec && this.oauthEligible(spec);
  }

  /** Connect every configured server in parallel. Resolves once all settle. */
  async connectAll(): Promise<void> {
    this.connected = true;
    await Promise.all(this.servers.map((s) => this.connectOne(s.name, s.spec)));
  }

  private async connectOne(name: string, spec: McpServerSpec): Promise<void> {
    const eligible = this.oauthEligible(spec);
    const explicitOAuth = isHttpSpec(spec) && !!spec.oauth;

    // Resolve any OAuth provider before connecting. A server explicitly
    // configured for OAuth but not yet signed in is flagged `needs-auth` without
    // even probing: attempting it would trigger dynamic registration + a browser
    // redirect we can't service at startup. With saved tokens we attach the
    // provider and connect (the SDK refreshes silently). Auto-detected servers
    // (no `oauth` config) are probed WITHOUT a provider, so a 401 surfaces as a
    // plain UnauthorizedError below — no registration happens until the user
    // explicitly authorizes.
    let authProvider: OAuthClientProvider | undefined;
    if (eligible && this.opts.createAuthProvider) {
      const provider =
        (await this.opts.createAuthProvider(name, spec as McpHttpServerSpec)) ?? undefined;
      if (provider && (await provider.tokens())) {
        authProvider = provider;
      } else if (explicitOAuth) {
        this.needsAuth.add(name);
        this.opts.logger?.info({ server: name }, "mcp server needs authorization");
        return;
      }
    }

    const make = this.opts.createTransport ?? ((_n, s, ap) => transportForSpec(s, ap));
    const client = new Client(this.opts.clientInfo ?? DEFAULT_CLIENT_INFO, {
      capabilities: {},
    });
    try {
      const transport = make(name, spec, authProvider);
      await client.connect(transport);
      await this.finalize(name, spec, client);
    } catch (err) {
      try {
        await client.close();
      } catch {
        // best-effort cleanup of a half-open client
      }
      if (err instanceof UnauthorizedError && eligible) {
        // Either stored tokens were rejected/expired, or an auto-detected server
        // is challenging for auth. Offer interactive authorization rather than
        // reporting a hard failure.
        this.needsAuth.add(name);
        this.opts.logger?.warn({ server: name }, "mcp server requires authorization");
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.failures.set(name, msg);
      this.opts.logger?.warn({ server: name, err: msg }, "mcp server failed to connect");
    }
  }

  /**
   * Discover a connected client's tools/prompts/resources and record the
   * connection. Clears any prior failed/needs-auth marker for the server.
   * Shared by startup ({@link connectOne}) and interactive {@link authorize}.
   */
  private async finalize(name: string, spec: McpServerSpec, client: Client): Promise<Connection> {
    const timeout = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const caps = client.getServerCapabilities();

    const { tools } = await client.listTools();
    const handlers = (tools as McpToolDescriptor[]).map((descriptor) =>
      mcpToolToHandler(name, descriptor, (toolName, args) =>
        this.invoke(name, client, toolName, args, timeout),
      ),
    );

    // Prompts and resources are gated on the server's declared capabilities —
    // listing one the server never advertised makes the SDK throw. Each
    // discovery is independently best-effort so a flaky prompts/list never
    // costs us the server's tools (or its resources).
    const prompts = caps?.prompts ? await this.discoverPrompts(name, client, timeout) : [];
    const hasResources = !!caps?.resources;
    const { resources, templates } = hasResources
      ? await this.discoverResources(name, client)
      : { resources: [], templates: [] };

    const conn: Connection = {
      name,
      spec,
      client,
      handlers,
      prompts,
      resources,
      templates,
      hasResources,
    };
    this.connections.set(name, conn);
    this.failures.delete(name);
    this.needsAuth.delete(name);
    this.opts.logger?.info(
      {
        server: name,
        tools: handlers.length,
        prompts: prompts.length,
        resources: resources.length,
      },
      "mcp server connected",
    );
    return conn;
  }

  /**
   * Drive the interactive OAuth grant for one configured server. Returns a
   * `redirect` result when the user must approve in a browser (the host opens
   * the URL, captures the `code`, and calls the returned `complete`), or
   * `connected` when the stored token was still good. See {@link McpAuthResult}.
   */
  async authorize(name: string): Promise<McpAuthResult> {
    const entry = this.servers.find((s) => s.name === name);
    if (!entry) return { status: "error", error: `Unknown MCP server "${name}".` };
    const spec = entry.spec;
    if (!this.oauthEligible(spec)) {
      return { status: "unsupported", error: `Server "${name}" is not configured for OAuth.` };
    }
    if (!this.opts.createAuthProvider) {
      return { status: "unsupported", error: "OAuth is not wired up in this host." };
    }
    // `oauthEligible` above guarantees `spec` is a remote (http/sse) server.
    const provider = ((await this.opts.createAuthProvider(name, spec as McpHttpServerSpec)) ??
      undefined) as RedirectAwareProvider | undefined;
    if (!provider) return { status: "unsupported", error: `No OAuth provider for "${name}".` };

    const make = this.opts.createTransport ?? ((_n, s, ap) => transportForSpec(s, ap));
    const connect = async (): Promise<McpAuthResult> => {
      const client = new Client(this.opts.clientInfo ?? DEFAULT_CLIENT_INFO, { capabilities: {} });
      const transport = make(name, spec, provider);
      try {
        await client.connect(transport);
        const conn = await this.finalize(name, spec, client);
        return {
          status: "connected",
          handlers: conn.handlers,
          prompts: conn.prompts,
          resourceTools: this.resourceTools(),
        };
      } catch (err) {
        try {
          await client.close();
        } catch {
          // best-effort cleanup
        }
        if (err instanceof UnauthorizedError && provider.authorizationUrl) {
          this.needsAuth.add(name);
          return {
            status: "redirect",
            authorizationUrl: provider.authorizationUrl,
            expectedState: provider.expectedState,
            complete: async (code: string) => {
              if (!canFinishAuth(transport)) {
                return { status: "error", error: "Transport cannot complete OAuth." };
              }
              try {
                await transport.finishAuth(code);
              } catch (e) {
                const m = e instanceof Error ? e.message : String(e);
                return { status: "error", error: `Token exchange failed: ${m}` };
              }
              // Fresh transport/client now that the provider holds tokens.
              return connect();
            },
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { status: "error", error: msg };
      }
    };
    return connect();
  }

  /**
   * Tear down a server's live connection and report the surfaces it had bridged,
   * so the host can unregister them from its tool/slash registries. An OAuth
   * server is moved back to `needs-auth` (it can be re-authorized); others just
   * drop out of the connected set. Does not touch persisted tokens — that is the
   * host's call (e.g. clearing the on-disk store on an explicit log-out).
   */
  async disconnect(name: string): Promise<{ toolNames: string[]; promptNames: string[] }> {
    const conn = this.connections.get(name);
    if (!conn) return { toolNames: [], promptNames: [] };
    const toolNames = conn.handlers.map((h) => h.definition.name);
    const promptNames = conn.prompts.map((p) => p.name);
    try {
      await conn.client.close();
    } catch {
      // best-effort teardown
    }
    this.connections.delete(name);
    const spec = this.servers.find((s) => s.name === name)?.spec;
    if (spec && this.oauthEligible(spec)) this.needsAuth.add(name);
    return { toolNames, promptNames };
  }

  /**
   * Re-attempt a server's connection from scratch (drop any stale client, clear
   * its failed/needs-auth markers, run the normal connect path). Returns the
   * resulting state; on `connected` the freshly-bridged handlers are available
   * via {@link handlers} for the host to register.
   */
  async reconnect(name: string): Promise<McpServerState> {
    const entry = this.servers.find((s) => s.name === name);
    if (!entry) return "failed";
    const existing = this.connections.get(name);
    if (existing) {
      try {
        await existing.client.close();
      } catch {
        // best-effort teardown
      }
      this.connections.delete(name);
    }
    this.failures.delete(name);
    this.needsAuth.delete(name);
    await this.connectOne(name, entry.spec);
    if (this.connections.has(name)) return "connected";
    if (this.needsAuth.has(name)) return "needs-auth";
    return "failed";
  }

  private async invoke(
    server: string,
    client: Client,
    toolName: string,
    args: Record<string, unknown>,
    timeout: number,
  ): Promise<{ output: string; isError: boolean }> {
    try {
      const res = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout,
      });
      const isError = res.isError === true;
      let output = formatContent((res as { content?: unknown }).content);
      if (!output) {
        const structured = (res as { structuredContent?: unknown }).structuredContent;
        if (structured !== undefined) output = JSON.stringify(structured, null, 2);
      }
      if (!output) output = isError ? "MCP tool returned an error." : "(no content)";
      return { output, isError };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn({ server, tool: toolName, err: msg }, "mcp tool call failed");
      return { output: `MCP tool call failed: ${msg}`, isError: true };
    }
  }

  /**
   * List a server's prompts and bridge each into a Nova slash command whose
   * `run` resolves the template via `prompts/get`. Best-effort: a failed list
   * yields no prompts rather than failing the whole connection.
   */
  private async discoverPrompts(
    server: string,
    client: Client,
    timeout: number,
  ): Promise<SlashCommand[]> {
    try {
      const { prompts } = await client.listPrompts();
      return (prompts as McpPromptDescriptor[]).map((descriptor) =>
        mcpPromptToSlash(server, descriptor, async (promptName, args) => {
          try {
            const res = await client.getPrompt({ name: promptName, arguments: args }, { timeout });
            const text = formatPromptMessages((res as { messages?: unknown }).messages);
            return { ok: text || "(prompt returned no content)" };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.opts.logger?.warn(
              { server, prompt: promptName, err: msg },
              "mcp getPrompt failed",
            );
            return { error: `MCP prompt "${promptName}" failed: ${msg}` };
          }
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn({ server, err: msg }, "mcp listPrompts failed");
      return [];
    }
  }

  /** List a server's static resources and resource templates (best-effort). */
  private async discoverResources(
    server: string,
    client: Client,
  ): Promise<{ resources: McpResourceDescriptor[]; templates: McpResourceTemplateDescriptor[] }> {
    const resources: McpResourceDescriptor[] = [];
    const templates: McpResourceTemplateDescriptor[] = [];
    try {
      const res = await client.listResources();
      resources.push(...((res.resources as McpResourceDescriptor[]) ?? []));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn({ server, err: msg }, "mcp listResources failed");
    }
    try {
      const res = await client.listResourceTemplates();
      templates.push(...((res.resourceTemplates as McpResourceTemplateDescriptor[]) ?? []));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger?.debug({ server, err: msg }, "mcp listResourceTemplates failed");
    }
    return { resources, templates };
  }

  /** Read a resource by URI, optionally constrained to one named server. */
  private async readResource(
    uri: string,
    server: string | undefined,
  ): Promise<{ output: string; isError: boolean }> {
    const candidates = Array.from(this.connections.values()).filter(
      (c) => c.hasResources && (server === undefined || c.name === server),
    );
    if (candidates.length === 0) {
      return {
        output: server
          ? `No connected MCP server named "${server}" exposes resources.`
          : "No connected MCP server exposes resources.",
        isError: true,
      };
    }
    const errors: string[] = [];
    for (const conn of candidates) {
      try {
        const res = await conn.client.readResource({ uri });
        const output = formatResourceContents((res as { contents?: unknown }).contents);
        return { output: output || "(resource is empty)", isError: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${conn.name}: ${msg}`);
      }
    }
    return { output: `Failed to read resource "${uri}" — ${errors.join("; ")}`, isError: true };
  }

  /** All successfully-bridged tool handlers across every connected server. */
  handlers(): ToolHandler[] {
    const out: ToolHandler[] = [];
    for (const conn of this.connections.values()) out.push(...conn.handlers);
    return out;
  }

  /** Bridged prompt slash commands across every connected server. */
  promptCommands(): SlashCommand[] {
    const out: SlashCommand[] = [];
    for (const conn of this.connections.values()) out.push(...conn.prompts);
    return out;
  }

  /**
   * The two global resource tools (`mcp_list_resources` / `mcp_read_resource`),
   * or an empty array when no connected server exposes resources. Closes over
   * the live connection map, so it reflects whatever connected.
   */
  resourceTools(): ToolHandler[] {
    if (!this.hasResources()) return [];
    return resourceToolHandlers(
      (server) => this.listResources(server),
      (uri, server) => this.readResource(uri, server),
    );
  }

  /** Group advertised resources by server, optionally filtered to one server. */
  private listResources(server?: string): McpServerResources[] {
    const out: McpServerResources[] = [];
    for (const conn of this.connections.values()) {
      if (!conn.hasResources) continue;
      if (server !== undefined && conn.name !== server) continue;
      out.push({ server: conn.name, resources: conn.resources, templates: conn.templates });
    }
    return out;
  }

  /** True if any connected server advertised the resources capability. */
  hasResources(): boolean {
    for (const conn of this.connections.values()) if (conn.hasResources) return true;
    return false;
  }

  /** True if any connected server exposed at least one prompt. */
  hasPrompts(): boolean {
    return this.promptCommands().length > 0;
  }

  /** True if any server connected and exposed at least one tool. */
  hasTools(): boolean {
    return this.handlers().length > 0;
  }

  /** Per-server connection status for display (`/mcp`). */
  status(): McpServerStatus[] {
    return this.servers.map(({ name, spec }) => {
      const conn = this.connections.get(name);
      const transport = transportKind(spec);
      if (conn) {
        const state: McpServerState = "connected";
        return {
          name,
          state,
          transport,
          toolCount: conn.handlers.length,
          toolNames: conn.handlers.map((h) => h.definition.name),
          promptCount: conn.prompts.length,
          promptNames: conn.prompts.map((p) => p.name),
          resourceCount: conn.resources.length + conn.templates.length,
        };
      }
      const state: McpServerState = this.needsAuth.has(name) ? "needs-auth" : "failed";
      const error =
        this.failures.get(name) ??
        (state === "needs-auth" ? "run `/mcp` and choose Authenticate to sign in" : undefined);
      return {
        name,
        state,
        transport,
        toolCount: 0,
        toolNames: [],
        promptCount: 0,
        promptNames: [],
        resourceCount: 0,
        ...(error ? { error } : {}),
      };
    });
  }

  /** Names of servers awaiting an interactive `/mcp` Authenticate grant. */
  serversNeedingAuth(): string[] {
    return [...this.needsAuth];
  }

  /** Total servers configured (connected + failed). */
  get serverCount(): number {
    return this.servers.length;
  }

  get connectedCount(): number {
    return this.connections.size;
  }

  /** Close every open client. Safe to call before or after connectAll(). */
  async close(): Promise<void> {
    if (!this.connected && this.connections.size === 0) return;
    await Promise.all(
      Array.from(this.connections.values()).map(async (conn) => {
        try {
          await conn.client.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.opts.logger?.warn({ server: conn.name, err: msg }, "mcp close failed");
        }
      }),
    );
    this.connections.clear();
  }
}
