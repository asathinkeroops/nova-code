import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { pluginSourceSchema, type PluginSource } from "@nova/runtime";
import { z } from "zod";

import { MANIFEST_DIRS } from "./manifest.js";
import { resolvePluginSource } from "./install.js";

const execFileP = promisify(execFile);

/** Where cloned marketplace catalogs are cached. */
export const DEFAULT_MARKETPLACE_CACHE_DIR = join(homedir(), ".nova", "plugins", "marketplaces");
const MARKETPLACE_FILE = "marketplace.json";

/** One plugin entry in a marketplace catalog. `source` is where to fetch it. */
export const marketplacePluginSchema = z
  .object({
    name: z.string().min(1),
    source: z.union([z.string().min(1), pluginSourceSchema]).optional(),
    description: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

/** A marketplace catalog (`.nova-plugin/marketplace.json` or `.claude-plugin/…`). */
export const marketplaceSchema = z
  .object({
    name: z.string().min(1),
    owner: z.union([z.string(), z.object({ name: z.string() }).passthrough()]).optional(),
    description: z.string().optional(),
    metadata: z.object({ pluginRoot: z.string().optional() }).passthrough().optional(),
    plugins: z.array(marketplacePluginSchema).default([]),
  })
  .passthrough();

export type Marketplace = z.infer<typeof marketplaceSchema>;

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

async function isFile(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  return !!s && s.isFile();
}

export interface LoadMarketplaceOptions {
  cacheDir?: string;
  home?: string;
}

/**
 * Materialize a marketplace source (local path resolved in place; github/git
 * shallow-cloned into the cache) and parse its `marketplace.json`.
 */
export async function loadMarketplace(
  name: string,
  source: string | PluginSource,
  opts: LoadMarketplaceOptions = {},
): Promise<{ catalog: Marketplace; root: string }> {
  const home = opts.home ?? homedir();
  const cacheDir = opts.cacheDir ?? DEFAULT_MARKETPLACE_CACHE_DIR;
  const src = typeof source === "string" ? resolvePluginSource(source) : source;

  let root: string;
  if (typeof src !== "string" && src.source === "path") {
    root = resolve(expandHome(src.path ?? "", home));
  } else if (typeof src !== "string" && (src.source === "github" || src.source === "git")) {
    await mkdir(cacheDir, { recursive: true });
    root = join(cacheDir, name);
    await rm(root, { recursive: true, force: true });
    const url = src.source === "github" ? `https://github.com/${src.repo}.git` : src.url!;
    const args = ["clone", "--depth", "1"];
    if (src.ref) args.push("--branch", src.ref);
    args.push(url, root);
    await execFileP("git", args);
  } else {
    throw new Error(`unsupported marketplace source: ${typeof src === "string" ? src : src.source}`);
  }

  let mp: string | undefined;
  for (const sub of MANIFEST_DIRS) {
    const p = join(root, sub, MARKETPLACE_FILE);
    if (await isFile(p)) {
      mp = p;
      break;
    }
  }
  if (!mp) throw new Error(`no ${MARKETPLACE_FILE} (.nova-plugin/ or .claude-plugin/) in ${root}`);
  const catalog = marketplaceSchema.parse(JSON.parse(await readFile(mp, "utf8")));
  return { catalog, root };
}

/**
 * Resolve a named plugin's install source from a loaded catalog. A string (or
 * `path`) source is relative to the marketplace root (plus `metadata.pluginRoot`);
 * an explicit github/git/npm source is returned verbatim.
 */
export function marketplacePluginSource(
  catalog: Marketplace,
  root: string,
  pluginName: string,
): PluginSource {
  const entry = catalog.plugins.find((p) => p.name === pluginName);
  if (!entry) throw new Error(`plugin "${pluginName}" not found in marketplace "${catalog.name}"`);
  const base = catalog.metadata?.pluginRoot ? resolve(root, catalog.metadata.pluginRoot) : root;
  const src = entry.source;
  if (src === undefined) return { source: "path", path: resolve(base, pluginName) };
  if (typeof src === "string") return { source: "path", path: resolve(base, src) };
  if (src.source === "path" && src.path) return { source: "path", path: resolve(base, src.path) };
  return src;
}
