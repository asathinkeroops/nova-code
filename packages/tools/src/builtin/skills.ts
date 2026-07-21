import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SkillListItem {
  name: string;
  /**
   * Model-facing summary used to decide when to load the skill. If the
   * SKILL.md front-matter carries a `when_to_use` field, it is appended here
   * (Claude Code semantics) so the combined text is what the model matches on.
   */
  description: string;
  /**
   * `disable-model-invocation: true` in front-matter. When set, the skill is
   * kept out of the model-facing `<available-skills>` block so the model won't
   * auto-invoke it; the user can still run it via `/{name}`. Default false.
   */
  disableModelInvocation: boolean;
  /**
   * `user-invocable: false` in front-matter. When set, the skill is not
   * registered as a `/{name}` slash command, so only the model can invoke it.
   * Default true.
   */
  userInvocable: boolean;
  /** Absolute path to the skill's directory (the parent of its SKILL.md). */
  location: string;
}

export interface SkillsLogger {
  warn(data: Record<string, unknown>, msg: string): void;
}

export interface SkillsOptions {
  cwd?: string;
  home?: string;
  projectDirs?: readonly string[];
  userPaths?: readonly string[];
  extraDirs?: readonly string[];
  /**
   * Optional sink for parse failures — one warn per bad SKILL.md. Defaults to
   * a no-op so library consumers don't get noise on stderr; the CLI wires its
   * own pino logger in.
   */
  logger?: SkillsLogger;
  /**
   * Byte cap for a single loadSkill tool response. Consumed by `builtinTools`
   * when it constructs the loadSkill tool — `getSkillList` / `getSkill`
   * ignore it. Not part of the scan cache key, so changing it never forces a
   * rescan. Default 16384.
   */
  maxResponseBytes?: number;
}

const DEFAULT_PROJECT_DIRS = [".nova/skills", ".claude/skills"] as const;
const DEFAULT_USER_DIRS = ["~/.nova/skills", "~/.claude/skills"] as const;

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const DESCRIPTION_MAX = 200;
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface CacheEntry {
  list: SkillListItem[];
}

interface ResolvedOpts {
  cwd: string;
  home: string;
  projectDirs: readonly string[];
  userPaths: readonly string[];
  extraDirs: readonly string[];
}

const cache = new Map<string, CacheEntry>();

function resolveOpts(opts: SkillsOptions | undefined): ResolvedOpts {
  return {
    cwd: opts?.cwd ?? process.cwd(),
    home: opts?.home ?? homedir(),
    projectDirs: opts?.projectDirs ?? DEFAULT_PROJECT_DIRS,
    userPaths: opts?.userPaths ?? DEFAULT_USER_DIRS,
    extraDirs: opts?.extraDirs ?? [],
  };
}

function cacheKey(r: ResolvedOpts): string {
  return JSON.stringify(r);
}

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

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ParsedSkill {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  body: string;
}

function parseSkillFile(text: string): { ok: ParsedSkill } | { error: string } {
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
  // Claude Code semantics: `when_to_use` is optional extra trigger context that
  // is appended to the description. We fold it in here so `description` is the
  // single model-facing string, then cap the combined length.
  const whenRaw = meta["when_to_use"];
  const whenToUse = typeof whenRaw === "string" ? whenRaw.trim() : "";
  const combined = whenToUse ? `${descRaw} ${whenToUse}` : descRaw;
  const description =
    combined.length > DESCRIPTION_MAX ? combined.slice(0, DESCRIPTION_MAX) : combined;
  // Who is allowed to invoke this skill (Claude Code semantics). Front-matter
  // scalars arrive as strings, so coerce leniently; unknown values fall back
  // to the permissive default.
  const disableModelInvocation = parseBool(meta["disable-model-invocation"], false);
  const userInvocable = parseBool(meta["user-invocable"], true);
  const body = normalized.slice(fm[0].length).trimStart();
  return { ok: { name, description, disableModelInvocation, userInvocable, body } };
}

/**
 * Tiny YAML-subset parser. Covers only what SKILL.md front-matter needs:
 *   key: scalar               (unquoted or "double"/'single' quoted)
 *   key: [a, b, c]            (flow-style array of scalars)
 *   key:
 *     - item                  (block-style array of scalars)
 *     - item
 * Anything else throws; the caller treats throws as parse failure.
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

/**
 * Coerce a front-matter value to a boolean. The tiny YAML parser only yields
 * strings, so accept case-insensitive "true"/"false"; anything else (missing,
 * array, typo) falls back to `dflt`.
 */
function parseBool(v: unknown, dflt: boolean): boolean {
  if (typeof v !== "string") return dflt;
  const s = v.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return dflt;
}

interface Target {
  kind: "user" | "project";
  root: string;
}

function scan(r: ResolvedOpts, logger: SkillsLogger | undefined): CacheEntry {
  const targets: Target[] = [];
  for (const d of r.projectDirs) targets.push({ kind: "project", root: resolve(r.cwd, d) });
  for (const d of r.userPaths) targets.push({ kind: "user", root: expandHome(d, r.home) });
  for (const d of r.extraDirs) targets.push({ kind: "user", root: expandHome(d, r.home) });

  const list: SkillListItem[] = [];
  const seen = new Set<string>();

  for (const t of targets) {
    if (!isDir(t.root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(t.root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch (err) {
      logger?.warn({ path: t.root, err: errMsg(err) }, "skill scan failed");
      continue;
    }
    for (const entryName of entries) {
      const dir = join(t.root, entryName);
      const path = join(dir, "SKILL.md");
      if (!isFile(path)) continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        logger?.warn({ path, err: errMsg(err) }, "skill parse failed");
        continue;
      }
      const parsed = parseSkillFile(text);
      if ("error" in parsed) {
        logger?.warn({ path, err: parsed.error }, "skill parse failed");
        continue;
      }
      if (seen.has(parsed.ok.name)) continue;
      list.push({
        name: parsed.ok.name,
        description: parsed.ok.description,
        disableModelInvocation: parsed.ok.disableModelInvocation,
        userInvocable: parsed.ok.userInvocable,
        location: dir,
      });
      seen.add(parsed.ok.name);
    }
  }
  return { list };
}

function ensureScanned(opts: SkillsOptions | undefined): CacheEntry {
  const resolved = resolveOpts(opts);
  const key = cacheKey(resolved);
  let entry = cache.get(key);
  if (entry) return entry;
  entry = scan(resolved, opts?.logger);
  cache.set(key, entry);
  return entry;
}

export function getSkillList(opts?: SkillsOptions): SkillListItem[] {
  return ensureScanned(opts).list;
}

export interface LoadedSkill {
  body: string;
  location: string;
}

export function getSkill(
  input: { name: string },
  opts?: SkillsOptions,
): LoadedSkill | undefined {
  const item = ensureScanned(opts).list.find((s) => s.name === input.name);
  if (!item) return undefined;
  let text: string;
  try {
    text = readFileSync(join(item.location, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseSkillFile(text);
  if ("error" in parsed) return undefined;
  return { body: parsed.ok.body, location: item.location };
}

/** Exported for tests; not part of the public API. */
export function _resetSkillsCacheForTests(): void {
  cache.clear();
}
