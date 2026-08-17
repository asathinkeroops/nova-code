import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Logger, PluginSource } from "@nova/base";

import { MANIFEST_DIRS, MANIFEST_FILE, pluginManifestSchema } from "./manifest.js";

const execFileP = promisify(execFile);

/** Where installed plugins are materialized; scanned at startup like any other dir. */
export const DEFAULT_PLUGIN_CACHE_DIR = join(homedir(), ".nova", "plugins", "cache");

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Parse a CLI `/plugin install <spec>` argument into a structured source:
 *   ./path, /abs, ~/p, file:… → path
 *   http(s)://…, git@…, ….git → git
 *   owner/repo (optionally #ref), github:owner/repo → github
 */
export function resolvePluginSource(spec: string): PluginSource {
  const s = spec.trim();
  if (s.startsWith(".") || s.startsWith("/") || s.startsWith("~") || s.startsWith("file:")) {
    return { source: "path", path: s.replace(/^file:/, "") };
  }
  if (/^https?:\/\//.test(s) || s.startsWith("git@") || s.endsWith(".git")) {
    return { source: "git", url: s };
  }
  const gh = s.replace(/^github:/, "");
  const m = /^([\w.-]+\/[\w.-]+)(?:#(.+))?$/.exec(gh);
  if (m) {
    return { source: "github", repo: m[1]!, ...(m[2] ? { ref: m[2] } : {}) };
  }
  return { source: "path", path: s };
}

async function isFile(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  return !!s && s.isFile();
}

async function findManifest(dir: string): Promise<string | undefined> {
  for (const sub of MANIFEST_DIRS) {
    const p = join(dir, sub, MANIFEST_FILE);
    if (await isFile(p)) return p;
  }
  return undefined;
}

async function readManifestName(dir: string): Promise<string> {
  const mp = await findManifest(dir);
  if (!mp) {
    throw new Error(`no plugin manifest (.nova-plugin/ or .claude-plugin/) found in ${dir}`);
  }
  return pluginManifestSchema.parse(JSON.parse(await readFile(mp, "utf8"))).name;
}

export interface InstallOptions {
  cacheDir?: string;
  home?: string;
  logger?: Logger;
}

export interface InstallResult {
  name: string;
  dir: string;
  source: PluginSource;
}

/**
 * Materialize a plugin into the cache. Local paths are copied; github/git
 * sources are shallow-cloned. The install directory is named after the plugin's
 * manifest `name`, so the startup scan discovers it like a hand-dropped plugin.
 */
export async function installPlugin(
  spec: string | PluginSource,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const cacheDir = opts.cacheDir ?? DEFAULT_PLUGIN_CACHE_DIR;
  const home = opts.home ?? homedir();
  const source = typeof spec === "string" ? resolvePluginSource(spec) : spec;
  await mkdir(cacheDir, { recursive: true });

  if (typeof source !== "string" && source.source === "path") {
    const src = resolve(expandHome(source.path ?? "", home));
    const name = await readManifestName(src);
    const dest = join(cacheDir, name);
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest, { recursive: true });
    return { name, dir: dest, source };
  }

  if (typeof source !== "string" && (source.source === "github" || source.source === "git")) {
    const url = source.source === "github" ? `https://github.com/${source.repo}.git` : source.url!;
    const staging = join(cacheDir, ".staging");
    await rm(staging, { recursive: true, force: true });
    const args = ["clone", "--depth", "1"];
    if (source.ref) args.push("--branch", source.ref);
    args.push(url, staging);
    await execFileP("git", args);
    const name = await readManifestName(staging);
    const dest = join(cacheDir, name);
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
    return { name, dir: dest, source };
  }

  throw new Error(
    `unsupported plugin source: ${typeof source === "string" ? source : source.source} ` +
      `(npm install is not supported yet)`,
  );
}

/** Remove an installed plugin's cache directory. */
export async function uninstallPlugin(name: string, opts: InstallOptions = {}): Promise<void> {
  const cacheDir = opts.cacheDir ?? DEFAULT_PLUGIN_CACHE_DIR;
  await rm(join(cacheDir, name), { recursive: true, force: true });
}
