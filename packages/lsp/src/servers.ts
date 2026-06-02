import { delimiter, extname, join } from "node:path";
import { accessSync, constants } from "node:fs";
import type { ServerConfig } from "./types.js";

/**
 * Built-in language server table. Each entry assumes the server binary is
 * already on the user's PATH (Nova does not install servers). Users can
 * override or extend this via `settings.lsp.servers`.
 */
export const DEFAULT_SERVERS: ServerConfig[] = [
  {
    languageId: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
  },
  {
    languageId: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: ["py", "pyi"],
  },
  {
    languageId: "go",
    command: "gopls",
    args: [],
    extensions: ["go"],
  },
  {
    languageId: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: ["rs"],
  },
];

/**
 * Merge user-provided server configs over the defaults, keyed by `languageId`.
 * A user entry fully replaces the matching default; unknown languageIds are
 * appended. Returns a fresh array.
 */
export function resolveServers(overrides?: ServerConfig[]): ServerConfig[] {
  if (!overrides || overrides.length === 0) return DEFAULT_SERVERS.map((s) => ({ ...s }));
  const byId = new Map<string, ServerConfig>();
  for (const s of DEFAULT_SERVERS) byId.set(s.languageId, { ...s });
  for (const s of overrides) byId.set(s.languageId, { ...s });
  return Array.from(byId.values());
}

/** Map an absolute/relative file path to the server that owns its extension. */
export function serverForPath(servers: ServerConfig[], path: string): ServerConfig | undefined {
  const ext = extname(path).replace(/^\./, "").toLowerCase();
  if (!ext) return undefined;
  return servers.find((s) => s.extensions.includes(ext));
}

/**
 * Resolve a command to an executable path by scanning PATH (and PATHEXT on
 * Windows). Absolute/relative commands containing a separator are checked
 * directly. Returns true when an executable file is found. Pure sync stat — no
 * spawning — so it is cheap to call before launching a server.
 */
export function isCommandAvailable(command: string): boolean {
  const isWin = process.platform === "win32";
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  const candidates = (dir: string): string[] =>
    exts.map((ext) => join(dir, command + ext));

  const check = (p: string): boolean => {
    try {
      accessSync(p, isWin ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (command.includes("/") || (isWin && command.includes("\\"))) {
    return exts.some((ext) => check(command + ext));
  }

  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (candidates(dir).some(check)) return true;
  }
  return false;
}
