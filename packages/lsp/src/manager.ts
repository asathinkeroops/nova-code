import { isAbsolute, resolve } from "node:path";
import { LspClient } from "./client.js";
import { isCommandAvailable, serverForPath } from "./servers.js";
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LspManagerOptions,
  Position,
  ServerConfig,
  SymbolInformation,
} from "./types.js";

/** Snapshot of one configured server's state, for status displays (e.g. /lsp). */
export interface LspServerStatus {
  languageId: string;
  command: string;
  extensions: string[];
  /** Binary resolvable on PATH right now. */
  available: boolean;
  /** A client has been started for this languageId in the current session. */
  running: boolean;
}

const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 3_000;

/**
 * Distinguishable failure for "we can't serve this request" (no server owns the
 * extension, or its binary isn't installed) versus an unexpected internal
 * error. The tool layer renders these as a normal is_error result, not a throw.
 */
export class LspUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspUnavailableError";
  }
}

/**
 * Owns one LspClient per languageId, lazily started on first use and reused
 * across calls, all rooted at a single workspace. The CLI builds one manager
 * per session and calls disposeAll() on exit. Clients are keyed by languageId
 * so e.g. `.ts` and `.tsx` share a single typescript-language-server process.
 */
export class LspManager {
  private readonly root: string;
  private readonly servers: ServerConfig[];
  private readonly initTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly diagnosticsTimeoutMs: number;
  private readonly logger: LspManagerOptions["logger"];
  private readonly clients = new Map<string, LspClient>();
  /** Servers we've already reported as missing, to avoid repeat probing churn. */
  private readonly unavailable = new Set<string>();

  constructor(opts: LspManagerOptions) {
    this.root = opts.root;
    this.servers = opts.servers;
    this.initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.diagnosticsTimeoutMs = opts.diagnosticsTimeoutMs ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
    this.logger = opts.logger;
  }

  private absPath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.root, path);
  }

  /** Resolve + start (or reuse) the server that owns `path`'s extension. */
  private async clientForPath(path: string): Promise<{ client: LspClient; abs: string }> {
    const abs = this.absPath(path);
    const config = serverForPath(this.servers, abs);
    if (!config) {
      throw new LspUnavailableError(
        `No language server configured for "${path}". Configured: ${this.servers
          .map((s) => `${s.languageId} (${s.extensions.join(", ")})`)
          .join("; ")}.`,
      );
    }
    const client = await this.startClient(config);
    return { client, abs };
  }

  private async startClient(config: ServerConfig): Promise<LspClient> {
    const existing = this.clients.get(config.languageId);
    if (existing) return existing;
    if (!isCommandAvailable(config.command)) {
      this.unavailable.add(config.languageId);
      throw new LspUnavailableError(
        `Language server "${config.command}" for ${config.languageId} is not installed or not on PATH.`,
      );
    }
    const client = new LspClient({
      config,
      root: this.root,
      initTimeoutMs: this.initTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      diagnosticsTimeoutMs: this.diagnosticsTimeoutMs,
      ...(this.logger ? { logger: this.logger } : {}),
    });
    this.clients.set(config.languageId, client);
    try {
      await client.start();
    } catch (err) {
      // Failed handshake: drop it so a later call can retry from scratch.
      this.clients.delete(config.languageId);
      throw err;
    }
    return client;
  }

  async definition(path: string, position: Position): Promise<Location[]> {
    const { client, abs } = await this.clientForPath(path);
    return client.definition(abs, position);
  }

  async references(path: string, position: Position, includeDeclaration = true): Promise<Location[]> {
    const { client, abs } = await this.clientForPath(path);
    return client.references(abs, position, includeDeclaration);
  }

  async hover(path: string, position: Position): Promise<Hover | undefined> {
    const { client, abs } = await this.clientForPath(path);
    return client.hover(abs, position);
  }

  async documentSymbols(path: string): Promise<DocumentSymbol[] | SymbolInformation[]> {
    const { client, abs } = await this.clientForPath(path);
    return client.documentSymbols(abs);
  }

  async diagnostics(path: string): Promise<Diagnostic[]> {
    const { client, abs } = await this.clientForPath(path);
    return client.getDiagnostics(abs);
  }

  /**
   * Workspace symbol search. With `pathHint`, queries the server owning that
   * file's extension; otherwise queries every already-started server and merges
   * results. Errors if no server can answer.
   */
  async workspaceSymbols(query: string, pathHint?: string): Promise<SymbolInformation[]> {
    if (pathHint) {
      const { client } = await this.clientForPath(pathHint);
      return client.workspaceSymbols(query);
    }
    const running = Array.from(this.clients.values());
    if (running.length === 0) {
      throw new LspUnavailableError(
        "No language server is running yet. Pass a file path to select a server, or run another LSP query first.",
      );
    }
    const results = await Promise.all(running.map((c) => c.workspaceSymbols(query)));
    return results.flat();
  }

  /**
   * Report every configured server: whether its binary is on PATH and whether
   * a client has already been started this session. Probes PATH synchronously,
   * so it reflects the live environment at call time.
   */
  status(): LspServerStatus[] {
    return this.servers.map((s) => ({
      languageId: s.languageId,
      command: s.command,
      extensions: [...s.extensions],
      available: isCommandAvailable(s.command),
      running: this.clients.has(s.languageId),
    }));
  }

  async disposeAll(): Promise<void> {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.allSettled(clients.map((c) => c.dispose()));
  }
}
