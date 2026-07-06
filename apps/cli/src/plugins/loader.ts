import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  fileCommandToSlash,
  loadFileCommands,
  type McpServerSpec,
  type SlashCommand,
} from "@nova/external";
import type { ServerConfig } from "@nova/lsp";
import { hooksConfigSchema, type HooksConfig, type Logger } from "@nova/runtime";
import { loadAgentDefinitions, type AgentDefinition } from "@nova/subagent";

import {
  asPathList,
  MANIFEST_DIRS,
  MANIFEST_FILE,
  pluginManifestSchema,
  type PluginManifest,
} from "./manifest.js";

/**
 * Loads plugins: distributable bundles that package the existing extension
 * types (slash commands, sub-agents, skills, shell hooks, MCP servers) under
 * one directory + manifest. Purely declarative — no plugin code is executed.
 * Each contribution is produced as plain data that the composition root
 * (`createContext`) folds into the live registries.
 *
 * Discovery mirrors the other markdown loaders: project dirs are scanned before
 * user dirs and the first manifest seen for a given plugin name wins (project
 * shadows user). Per-plugin failures are isolated — a broken manifest is
 * recorded in `errors` and never aborts the load, exactly like MCP connect.
 */

/** A component the loader recognizes but does not wire (no nova runtime for it). */
export interface IgnoredComponent {
  kind: "monitors";
  path: string;
  reason?: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute plugin directory — the value substituted for `${CLAUDE_PLUGIN_ROOT}`. */
  root: string;
  source: "project" | "user";
  /** Namespaced (`<plugin>:<name>`) slash commands with `source.kind === "plugin"`. */
  commands: SlashCommand[];
  /** Sub-agent definitions (bare names; collisions resolved first-wins by the registry). */
  agents: AgentDefinition[];
  /** Absolute paths of skill directories (each contains a SKILL.md). */
  skills: string[];
  /** Merged shell-hook config with `${CLAUDE_PLUGIN_ROOT}` expanded; undefined if none. */
  hooks: HooksConfig | undefined;
  /** MCP server specs keyed by namespaced name (`<plugin>__<server>`). */
  mcpServers: Record<string, McpServerSpec>;
  /** LSP server configs from `.lsp.json`, merged into the LspManager table. */
  lspServers: ServerConfig[];
  /** Absolute `bin/` directories to prepend to PATH for subprocess tools. */
  binDirs: string[];
  /** Recognized-but-unwired components, surfaced by `/plugin list`. */
  ignored: IgnoredComponent[];
}

export interface PluginError {
  name?: string;
  dir: string;
  message: string;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  errors: PluginError[];
}

export interface LoadPluginsOpts {
  cwd: string;
  home?: string;
  /** Project-relative plugin roots (resolved against cwd). */
  projectDirs: string[];
  /** User plugin roots (`~` expanded). */
  userDirs: string[];
  /** Plugin names to skip. */
  disabled?: string[];
  logger?: Logger;
}

const PLUGIN_ROOT_VARS = ["${CLAUDE_PLUGIN_ROOT}", "${NOVA_PLUGIN_ROOT}"] as const;

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function isDir(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  return !!s && s.isDirectory();
}

async function isFile(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  return !!s && s.isFile();
}

/** Recursively replace `${CLAUDE_PLUGIN_ROOT}` / `${NOVA_PLUGIN_ROOT}` in a JSON value. */
function expandPluginVars<T>(value: T, root: string): T {
  if (typeof value === "string") {
    let out: string = value;
    for (const v of PLUGIN_ROOT_VARS) out = out.split(v).join(root);
    return out as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandPluginVars(v, root)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandPluginVars(v, root);
    return out as T;
  }
  return value;
}

/** Locate a plugin manifest under a candidate dir; `.nova-plugin` wins over `.claude-plugin`. */
async function findManifestPath(dir: string): Promise<string | undefined> {
  for (const sub of MANIFEST_DIRS) {
    const p = join(dir, sub, MANIFEST_FILE);
    if (await isFile(p)) return p;
  }
  return undefined;
}

/** Scan a plugin's commands dir(s) and return namespaced slash commands. */
async function loadPluginCommands(manifest: PluginManifest, root: string): Promise<SlashCommand[]> {
  const dirs = asPathList(manifest.commands);
  const projectDirs = dirs.length > 0 ? dirs : ["commands"];
  const { commands } = await loadFileCommands({ cwd: root, projectDirs, userPaths: [] });
  return commands.map((raw) => {
    const base = fileCommandToSlash(raw);
    return {
      ...base,
      name: `${manifest.name}:${raw.name}`,
      source: { kind: "plugin" as const, ...(raw.path ? { path: raw.path } : {}) },
    };
  });
}

/** Scan a plugin's agents dir(s). Names stay bare; the registry resolves collisions. */
function loadPluginAgents(
  manifest: PluginManifest,
  root: string,
  logger?: Logger,
): AgentDefinition[] {
  const dirs = asPathList(manifest.agents);
  const projectDirs = dirs.length > 0 ? dirs : ["agents"];
  const { defs } = loadAgentDefinitions({
    cwd: root,
    projectDirs,
    userPaths: [],
    ...(logger ? { logger } : {}),
  });
  return defs;
}

/** Return absolute paths of skill directories (each holding a SKILL.md). */
async function loadPluginSkills(manifest: PluginManifest, root: string): Promise<string[]> {
  const dirs = asPathList(manifest.skills);
  const roots = dirs.length > 0 ? dirs.map((d) => resolve(root, d)) : [resolve(root, "skills")];
  const found: string[] = [];
  for (const skillsRoot of roots) {
    if (!(await isDir(skillsRoot))) continue;
    const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      const skillDir = join(skillsRoot, e.name);
      if (await isFile(join(skillDir, "SKILL.md"))) found.push(skillDir);
    }
  }
  return found;
}

/** Read + expand + parse a plugin's shell-hook config. */
async function loadPluginHooks(
  manifest: PluginManifest,
  root: string,
): Promise<HooksConfig | undefined> {
  const files = asPathList(manifest.hooks);
  const candidates =
    files.length > 0 ? files.map((f) => resolve(root, f)) : [resolve(root, "hooks", "hooks.json")];
  const sources: HooksConfig[] = [];
  for (const file of candidates) {
    if (!(await isFile(file))) continue;
    const text = await readFile(file, "utf8");
    const expanded = expandPluginVars(JSON.parse(text), root);
    sources.push(hooksConfigSchema.parse(expanded));
  }
  if (sources.length === 0) return undefined;
  // A single plugin rarely declares more than one hook file; concatenate arrays.
  const merged = hooksConfigSchema.parse({});
  merged.enabled = sources.every((s) => s.enabled);
  for (const src of sources) {
    for (const ev of [
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
      "SessionStart",
      "SessionEnd",
      "PreCompact",
      "PostCompact",
    ] as const) {
      merged[ev].push(...src[ev]);
    }
  }
  return merged;
}

/** Read plugin MCP servers, namespaced `<plugin>__<server>`, vars expanded. */
async function loadPluginMcp(
  manifest: PluginManifest,
  root: string,
): Promise<Record<string, McpServerSpec>> {
  let raw: unknown;
  if (typeof manifest.mcpServers === "object" && manifest.mcpServers !== null) {
    raw = { mcpServers: manifest.mcpServers };
  } else {
    const file =
      typeof manifest.mcpServers === "string"
        ? resolve(root, manifest.mcpServers)
        : resolve(root, ".mcp.json");
    if (!(await isFile(file))) return {};
    raw = JSON.parse(await readFile(file, "utf8"));
  }
  const expanded = expandPluginVars(raw, root) as Record<string, unknown>;
  // Accept either `{ mcpServers: {...} }` (CC / .mcp.json) or a bare `{...}` map.
  const servers = (
    expanded && typeof expanded.mcpServers === "object" ? expanded.mcpServers : expanded
  ) as Record<string, unknown>;
  const out: Record<string, McpServerSpec> = {};
  for (const [name, spec] of Object.entries(servers ?? {})) {
    if (!spec || typeof spec !== "object") continue;
    out[`${manifest.name}__${name}`] = spec as McpServerSpec;
  }
  return out;
}

/** Read plugin LSP server configs from `.lsp.json` (array or `{ servers: [...] }`). */
async function loadPluginLsp(manifest: PluginManifest, root: string): Promise<ServerConfig[]> {
  const files = asPathList(manifest.lsp);
  const candidates = files.length > 0 ? files.map((f) => resolve(root, f)) : [resolve(root, ".lsp.json")];
  const out: ServerConfig[] = [];
  for (const file of candidates) {
    if (!(await isFile(file))) continue;
    const raw = expandPluginVars(JSON.parse(await readFile(file, "utf8")), root) as
      | unknown[]
      | { servers?: unknown[] };
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.servers) ? raw.servers : [];
    for (const s of list) {
      const c = s as Partial<ServerConfig>;
      if (c && typeof c.languageId === "string" && typeof c.command === "string") {
        out.push({
          languageId: c.languageId,
          command: c.command,
          args: Array.isArray(c.args) ? c.args : [],
          extensions: Array.isArray(c.extensions) ? c.extensions : [],
        });
      }
    }
  }
  return out;
}

/** Absolute `bin/` directory if present. */
async function loadPluginBin(root: string): Promise<string[]> {
  const bin = resolve(root, "bin");
  return (await isDir(bin)) ? [bin] : [];
}

/** Recognized components nova has no runtime for (currently just `monitors/`). */
async function detectIgnored(root: string): Promise<IgnoredComponent[]> {
  const out: IgnoredComponent[] = [];
  const monitors = join(root, "monitors");
  if (await isDir(monitors)) out.push({ kind: "monitors", path: monitors, reason: "not supported" });
  return out;
}

async function assemblePlugin(
  manifest: PluginManifest,
  root: string,
  source: "project" | "user",
  logger?: Logger,
): Promise<LoadedPlugin> {
  const [commands, skills, hooks, mcpServers, lspServers, binDirs, ignored] = await Promise.all([
    loadPluginCommands(manifest, root),
    loadPluginSkills(manifest, root),
    loadPluginHooks(manifest, root),
    loadPluginMcp(manifest, root),
    loadPluginLsp(manifest, root),
    loadPluginBin(root),
    detectIgnored(root),
  ]);
  const agents = loadPluginAgents(manifest, root, logger);
  return {
    manifest,
    root,
    source,
    commands,
    agents,
    skills,
    hooks,
    mcpServers,
    lspServers,
    binDirs,
    ignored,
  };
}

export async function loadPlugins(opts: LoadPluginsOpts): Promise<PluginLoadResult> {
  const home = opts.home ?? homedir();
  const disabled = new Set(opts.disabled ?? []);
  const targets: Array<{ source: "project" | "user"; base: string }> = [];
  for (const d of opts.projectDirs) targets.push({ source: "project", base: resolve(opts.cwd, d) });
  for (const d of opts.userDirs) targets.push({ source: "user", base: expandHome(d, home) });

  const plugins: LoadedPlugin[] = [];
  const errors: PluginError[] = [];
  const seen = new Set<string>();

  for (const t of targets) {
    if (!(await isDir(t.base))) continue;
    const entries = await readdir(t.base, { withFileTypes: true }).catch((err) => {
      opts.logger?.warn({ path: t.base, err: errMsg(err) }, "plugin scan failed");
      return [];
    });
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      const dir = join(t.base, e.name);
      const manifestPath = await findManifestPath(dir);
      if (!manifestPath) continue; // not a plugin directory
      try {
        const manifest = pluginManifestSchema.parse(
          JSON.parse(await readFile(manifestPath, "utf8")),
        );
        if (disabled.has(manifest.name) || seen.has(manifest.name)) continue;
        seen.add(manifest.name);
        plugins.push(await assemblePlugin(manifest, dir, t.source, opts.logger));
      } catch (err) {
        errors.push({ dir, message: errMsg(err) });
        opts.logger?.warn({ path: manifestPath, err: errMsg(err) }, "plugin load failed");
      }
    }
  }

  return { plugins, errors };
}
