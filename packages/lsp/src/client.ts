import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RpcConnection } from "./rpc.js";
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  Position,
  ServerConfig,
  SymbolInformation,
} from "./types.js";

export interface LspClientOptions {
  config: ServerConfig;
  /** Absolute workspace root used as the server rootUri. */
  root: string;
  initTimeoutMs: number;
  requestTimeoutMs: number;
  diagnosticsTimeoutMs: number;
  logger?: {
    debug: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

interface OpenDoc {
  version: number;
}

/**
 * One running language server plus its document-sync state. The manager owns a
 * client per languageId and reuses it across calls. A client is single-server,
 * single-workspace; it lazily opens documents on first reference and keeps the
 * latest disk contents in sync via didChange so diagnostics/positions are fresh.
 */
export class LspClient {
  private readonly opts: LspClientOptions;
  private child: ChildProcessWithoutNullStreams | undefined;
  private rpc: RpcConnection | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly openDocs = new Map<string, OpenDoc>();
  private readonly diagnosticsByUri = new Map<string, Diagnostic[]>();
  /** Resolvers waiting for the next publishDiagnostics of a given uri. */
  private readonly diagWaiters = new Map<string, Array<() => void>>();
  private disposed = false;

  constructor(opts: LspClientOptions) {
    this.opts = opts;
  }

  /** Spawn + initialize on first call; subsequent calls await the same promise. */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().catch((err) => {
      // Reset so a later call can retry a transient spawn failure.
      this.startPromise = undefined;
      throw err;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const { config, root } = this.opts;
    const child = spawn(config.command, config.args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (err) => {
      this.opts.logger?.error({ err, command: config.command }, "lsp server spawn error");
      this.rpc?.dispose(err instanceof Error ? err : new Error(String(err)));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.opts.logger?.debug({ languageId: config.languageId, stderr: chunk.toString("utf8") });
    });

    this.rpc = new RpcConnection(child.stdin, child.stdout, {
      requestTimeoutMs: this.opts.requestTimeoutMs,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onServerRequest(method, params),
      onClose: () => {
        if (!this.disposed) {
          this.opts.logger?.warn({ languageId: config.languageId }, "lsp server closed");
        }
      },
    });

    const rootUri = pathToFileURL(root).href;
    const initTimeout = setTimeout(() => {
      this.rpc?.dispose(new Error(`lsp initialize timed out after ${this.opts.initTimeoutMs}ms`));
    }, this.opts.initTimeoutMs);
    try {
      await this.rpc.request("initialize", {
        processId: process.pid,
        rootUri,
        rootPath: root,
        workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        capabilities: clientCapabilities(),
      });
    } finally {
      clearTimeout(initTimeout);
    }
    this.rpc.notify("initialized", {});
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as { uri?: string; diagnostics?: Diagnostic[] } | undefined;
      if (p?.uri) {
        this.diagnosticsByUri.set(p.uri, p.diagnostics ?? []);
        const waiters = this.diagWaiters.get(p.uri);
        if (waiters) {
          this.diagWaiters.delete(p.uri);
          for (const w of waiters) w();
        }
      }
    }
  }

  private onServerRequest(method: string, params: unknown): unknown {
    // Reply benignly to the handful of requests servers make during init so
    // they never block. workspace/configuration expects one result per
    // requested item; we advertise no config, so each resolves to an empty
    // object. Everything else (registerCapability, workDoneProgress/create,
    // …) gets a null result.
    if (method === "workspace/configuration") {
      const items = (params as { items?: unknown[] } | undefined)?.items;
      return Array.isArray(items) ? items.map(() => ({})) : [];
    }
    return null;
  }

  /** Open the document (or sync its latest disk contents) before a query. */
  private async ensureOpen(absPath: string): Promise<string> {
    if (!this.rpc) throw new Error("lsp client not started");
    const uri = pathToFileURL(absPath).href;
    const text = await readFile(absPath, "utf8");
    const existing = this.openDocs.get(uri);
    if (existing) {
      existing.version += 1;
      this.rpc.notify("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }],
      });
    } else {
      this.openDocs.set(uri, { version: 1 });
      this.rpc.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.opts.config.languageId,
          version: 1,
          text,
        },
      });
    }
    return uri;
  }

  async definition(absPath: string, position: Position): Promise<Location[]> {
    const uri = await this.ensureOpen(absPath);
    const res = await this.req("textDocument/definition", {
      textDocument: { uri },
      position,
    });
    return normalizeLocations(res);
  }

  async references(absPath: string, position: Position, includeDeclaration = true): Promise<Location[]> {
    const uri = await this.ensureOpen(absPath);
    const res = await this.req("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
    return normalizeLocations(res);
  }

  async hover(absPath: string, position: Position): Promise<Hover | undefined> {
    const uri = await this.ensureOpen(absPath);
    const res = await this.req("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    return (res as Hover | null) ?? undefined;
  }

  async documentSymbols(absPath: string): Promise<DocumentSymbol[] | SymbolInformation[]> {
    const uri = await this.ensureOpen(absPath);
    const res = await this.req("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    return (res as DocumentSymbol[] | SymbolInformation[] | null) ?? [];
  }

  async workspaceSymbols(query: string): Promise<SymbolInformation[]> {
    const res = await this.req("workspace/symbol", { query });
    return (res as SymbolInformation[] | null) ?? [];
  }

  /** Open the file and wait (briefly) for the server to publish diagnostics. */
  async getDiagnostics(absPath: string): Promise<Diagnostic[]> {
    const uri = await this.ensureOpen(absPath);
    await this.waitForDiagnostics(uri);
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  private waitForDiagnostics(uri: string): Promise<void> {
    const timeoutMs = this.opts.diagnosticsTimeoutMs;
    if (timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const waiters = this.diagWaiters.get(uri) ?? [];
      waiters.push(done);
      this.diagWaiters.set(uri, waiters);
    });
  }

  private async req(method: string, params: unknown): Promise<unknown> {
    if (!this.rpc) throw new Error("lsp client not started");
    return this.rpc.request(method, params);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const rpc = this.rpc;
    const child = this.child;
    if (rpc) {
      try {
        await Promise.race([
          rpc.request("shutdown"),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
        rpc.notify("exit");
      } catch {
        // best-effort
      }
      rpc.dispose();
    }
    if (child && !child.killed) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1000);
      killTimer.unref?.();
    }
  }
}

/** definition/references may return a single Location, an array, or LocationLinks. */
function normalizeLocations(res: unknown): Location[] {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  const out: Location[] = [];
  for (const item of arr) {
    const loc = item as Partial<Location> & Partial<LocationLink>;
    if (loc.uri && loc.range) {
      out.push({ uri: loc.uri, range: loc.range });
    } else if (loc.targetUri && loc.targetRange) {
      out.push({ uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange });
    }
  }
  return out;
}

function clientCapabilities(): Record<string, unknown> {
  return {
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: false },
      definition: { dynamicRegistration: false, linkSupport: true },
      references: { dynamicRegistration: false },
      hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
      documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
      publishDiagnostics: { relatedInformation: true },
    },
    workspace: {
      symbol: { dynamicRegistration: false },
      configuration: true,
      workspaceFolders: true,
    },
  };
}
