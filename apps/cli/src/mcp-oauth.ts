import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import {
  createNovaOAuthProvider,
  type McpHttpServerSpec,
  type OAuthStore,
  type StoredOAuth,
} from "@nova/mcp";
import type { Settings } from "@nova/runtime";

/** Directory holding one `<server>.json` OAuth blob per authenticated server. */
function authDir(): string {
  return join(homedir(), ".nova", "mcp-auth");
}

/** Map a server name to a safe filename (config keys are arbitrary strings). */
function authFile(server: string): string {
  const safe = server.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(authDir(), `${safe}.json`);
}

/**
 * File-backed {@link OAuthStore}: persists tokens + client registration as a
 * single JSON blob per server, owner-readable only (mode 0600) since it holds
 * refresh-token secrets. Missing/corrupt files read as "no saved auth".
 */
export class FileOAuthStore implements OAuthStore {
  constructor(private readonly server: string) {}

  async load(): Promise<StoredOAuth | undefined> {
    try {
      const raw = await readFile(authFile(this.server), "utf8");
      return JSON.parse(raw) as StoredOAuth;
    } catch {
      return undefined;
    }
  }

  async save(state: StoredOAuth): Promise<void> {
    const path = authFile(this.server);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await rm(authFile(this.server), { force: true });
  }
}

/** The loopback redirect URL the OAuth provider registers and listens on. */
export function oauthRedirectUrl(settings: Settings): string {
  const { callbackHost, callbackPort } = settings.mcp.oauth;
  return `http://${callbackHost}:${callbackPort}/callback`;
}

/**
 * Build the OAuth provider factory wired into {@link buildMcpManager}. Each
 * server gets its own {@link FileOAuthStore} keyed by name; the redirect URL is
 * shared (and stable) so a client registered once keeps working.
 */
export function makeAuthProviderFactory(settings: Settings) {
  const redirectUrl = oauthRedirectUrl(settings);
  return (name: string, spec: McpHttpServerSpec) =>
    createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl,
      store: new FileOAuthStore(name),
      ...(spec.oauth?.scope ? { scope: spec.oauth.scope } : {}),
    });
}

export interface CallbackResult {
  code: string;
  state?: string;
}

export interface CallbackServer {
  /** Resolves with the authorization code once the browser redirect arrives. */
  waitForCode: Promise<CallbackResult>;
  /** Tear the loopback server down (idempotent). */
  close: () => void;
}

/**
 * Start the loopback HTTP server that catches the OAuth redirect. Binds the
 * fixed callback host/port (so it matches the registered `redirect_uri`) and
 * resolves `waitForCode` on the first `/callback` hit carrying a `code`. The
 * returned promise rejects if the port can't be bound (e.g. already in use).
 */
export function startCallbackServer(settings: Settings): Promise<CallbackServer> {
  const { callbackHost, callbackPort } = settings.mcp.oauth;
  let resolveCode: (r: CallbackResult) => void;
  let rejectCode: (e: Error) => void;
  const waitForCode = new Promise<CallbackResult>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${callbackHost}:${callbackPort}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error) {
      res
        .writeHead(400, { "content-type": "text/html" })
        .end(page(`Authorization failed: ${error}`));
      rejectCode(new Error(`Authorization server returned "${error}".`));
      return;
    }
    if (!code) {
      res.writeHead(400, { "content-type": "text/html" }).end(page("Missing authorization code."));
      rejectCode(new Error("Redirect carried no authorization code."));
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(page("Authorization complete — you can close this tab and return to Nova."));
    resolveCode({ code, state: url.searchParams.get("state") ?? undefined });
  });

  return new Promise<CallbackServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, callbackHost, () => {
      server.removeListener("error", reject);
      resolve({
        waitForCode,
        close: () => server.close(),
      });
    });
  });
}

function page(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Nova MCP</title></head><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>Nova</h2><p>${message}</p></body></html>`;
}

/**
 * Best-effort: open `url` in the user's default browser. Never throws — the
 * caller always also prints the URL so a headless box can copy it by hand.
 */
export function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignored — the URL is printed for manual opening
  }
}
