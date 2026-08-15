import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentDefinition } from "./definitions.js";

/**
 * Loads custom sub-agent definitions from markdown files, mirroring the
 * skills / slash-command loaders. Each `*.md` under an agents directory is one
 * definition: YAML-subset front-matter (name, description, tools, readOnly,
 * model, maxTurns, maxTokens) plus a body that becomes the sub-agent's role
 * guidance.
 *
 * Layering: project dirs are scanned before user dirs, and the first
 * definition seen for a given name wins — so project shadows user. Built-ins
 * are layered on separately (and always win) by the `AgentRegistry`.
 */

export interface AgentsLogger {
  warn(data: Record<string, unknown>, msg: string): void;
}

export interface AgentLoadOptions {
  cwd?: string;
  home?: string;
  projectDirs?: readonly string[];
  userPaths?: readonly string[];
  extraDirs?: readonly string[];
  logger?: AgentsLogger;
}

export interface AgentLoadResult {
  defs: AgentDefinition[];
  errors: Array<{ path: string; message: string }>;
}

const DEFAULT_PROJECT_DIRS = [".nova/agents", ".claude/agents"] as const;
const DEFAULT_USER_DIRS = ["~/.nova/agents", "~/.claude/agents"] as const;

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const DESCRIPTION_MAX = 200;
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tiny YAML-subset parser — same dialect the skills loader uses. Covers:
 *   key: scalar               (unquoted or "double"/'single' quoted)
 *   key: [a, b, c]            (flow-style array of scalars)
 *   key:
 *     - item                  (block-style array of scalars)
 * Anything else throws; the caller treats throws as a parse failure.
 */
function parseFrontMatter(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) throw new Error(`unrecognized front-matter line: ${line}`);
    const key = m[1] as string;
    const rest = (m[2] ?? "").trim();
    if (rest === "") {
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        const dash = /^\s*-\s*(.*)$/.exec(next);
        if (!dash) break;
        items.push(parseScalar((dash[1] ?? "").trim()));
        i++;
      }
      out[key] = items;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      out[key] = inner === "" ? [] : inner.split(",").map((s) => parseScalar(s.trim()));
    } else {
      out[key] = parseScalar(rest);
    }
    i++;
  }
  return out;
}

function parseScalar(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function asPositiveInt(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseAgentFile(
  text: string,
  source: "project" | "user",
  path: string,
): { ok: AgentDefinition } | { error: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const fm = FRONT_MATTER_RE.exec(normalized);
  if (!fm) return { error: "missing front-matter" };
  let meta: Record<string, unknown>;
  try {
    meta = parseFrontMatter(fm[1] ?? "");
  } catch (e) {
    return { error: errMsg(e) };
  }

  const name = meta["name"];
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { error: `invalid or missing name (must match ${NAME_RE.source})` };
  }
  const descRaw = meta["description"];
  if (typeof descRaw !== "string" || descRaw.trim().length === 0) {
    return { error: "missing description" };
  }
  const description =
    descRaw.length > DESCRIPTION_MAX ? descRaw.slice(0, DESCRIPTION_MAX) : descRaw;

  const toolsRaw = meta["tools"];
  const allowTools = Array.isArray(toolsRaw)
    ? toolsRaw.filter((x): x is string => typeof x === "string" && x.length > 0)
    : undefined;

  const model = typeof meta["model"] === "string" && meta["model"] ? meta["model"] : undefined;
  const readOnly = asBool(meta["readOnly"]) ?? false;
  const maxTurns = asPositiveInt(meta["maxTurns"]);
  const maxTokens = asPositiveInt(meta["maxTokens"]);

  const guidance = normalized.slice(fm[0].length).trim();
  const roleLine = `a specialized "${name}" worker spawned by a parent agent to complete ONE focused task and report back`;

  return {
    ok: {
      name,
      description,
      roleLine,
      guidance,
      readOnly,
      ...(allowTools && allowTools.length > 0 ? { allowTools } : {}),
      ...(model ? { model } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      source,
      path,
    },
  };
}

interface Target {
  kind: "project" | "user";
  root: string;
}

/**
 * Scan the agents directories and return definitions in priority order
 * (project before user; within a layer, the listed-dir order). Duplicate names
 * are kept once (first wins); later duplicates are dropped silently — the
 * registry reports built-in collisions, and same-layer dupes are a user
 * mistake the first-wins rule resolves deterministically.
 */
export function loadAgentDefinitions(opts: AgentLoadOptions = {}): AgentLoadResult {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const projectDirs = opts.projectDirs ?? DEFAULT_PROJECT_DIRS;
  const userPaths = opts.userPaths ?? DEFAULT_USER_DIRS;
  const extraDirs = opts.extraDirs ?? [];

  const targets: Target[] = [];
  for (const d of projectDirs) targets.push({ kind: "project", root: resolve(cwd, d) });
  for (const d of userPaths) targets.push({ kind: "user", root: expandHome(d, home) });
  for (const d of extraDirs) targets.push({ kind: "user", root: expandHome(d, home) });

  const defs: AgentDefinition[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const seen = new Set<string>();

  for (const t of targets) {
    if (!isDir(t.root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(t.root, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      opts.logger?.warn({ path: t.root, err: errMsg(err) }, "agent scan failed");
      continue;
    }
    for (const entryName of entries) {
      const path = join(t.root, entryName);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        errors.push({ path, message: errMsg(err) });
        opts.logger?.warn({ path, err: errMsg(err) }, "agent read failed");
        continue;
      }
      const parsed = parseAgentFile(text, t.kind, path);
      if ("error" in parsed) {
        errors.push({ path, message: parsed.error });
        opts.logger?.warn({ path, err: parsed.error }, "agent parse failed");
        continue;
      }
      if (seen.has(parsed.ok.name)) continue;
      seen.add(parsed.ok.name);
      defs.push(parsed.ok);
    }
  }

  return { defs, errors };
}
