import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  frontMatterBool,
  frontMatterText,
  splitFrontMatter,
} from "@nova/runtime";

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
  /**
   * Root directory of the plugin that shipped this skill, when it came from
   * one. Plugin skills reach the scanner through `extraDirs` like any other
   * path, which loses the association — `pluginRoots` restores it so a plugin
   * skill's body can resolve `${CLAUDE_PLUGIN_ROOT}`.
   */
  pluginRoot?: string;
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
  /**
   * Byte cap for a single `SKILL.md` on disk. A file over the cap is skipped
   * with a warn rather than read, so a runaway or accidentally-huge file can't
   * be pulled into memory during the startup scan. Unlike `maxResponseBytes`
   * this *is* part of the scan cache key, because it changes which skills
   * exist. Default 1048576 (1 MiB), matching Claude Code.
   */
  maxFileBytes?: number;
  /**
   * Disable inline `` !`cmd` `` execution in SKILL.md bodies. Like
   * `maxResponseBytes`, consumed by `builtinTools` when it builds the loadSkill
   * tool; the scan functions ignore it, so it is not part of the cache key.
   */
  disableShellExecution?: boolean;
  /**
   * Maps a scanned directory (as passed in `extraDirs`) to the plugin root that
   * owns it, so skills found there carry a `pluginRoot`. Plain data rather than
   * a lookup function because it takes part in the scan cache key.
   */
  pluginRoots?: Readonly<Record<string, string>>;
}

const DEFAULT_PROJECT_DIRS = [".nova/skills", ".claude/skills"] as const;
const DEFAULT_USER_DIRS = ["~/.nova/skills", "~/.claude/skills"] as const;
const DEFAULT_MAX_FILE_BYTES = 1_048_576;

const NAME_RE = /^[a-z][a-z0-9-]*$/;

interface CacheEntry {
  list: SkillListItem[];
}

interface ResolvedOpts {
  cwd: string;
  home: string;
  projectDirs: readonly string[];
  userPaths: readonly string[];
  extraDirs: readonly string[];
  maxFileBytes: number;
  pluginRoots: Readonly<Record<string, string>>;
}

const cache = new Map<string, CacheEntry>();

function resolveOpts(opts: SkillsOptions | undefined): ResolvedOpts {
  return {
    cwd: opts?.cwd ?? process.cwd(),
    home: opts?.home ?? homedir(),
    projectDirs: opts?.projectDirs ?? DEFAULT_PROJECT_DIRS,
    userPaths: opts?.userPaths ?? DEFAULT_USER_DIRS,
    extraDirs: opts?.extraDirs ?? [],
    maxFileBytes: opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    pluginRoots: opts?.pluginRoots ?? {},
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

/**
 * Read a `SKILL.md` after checking its size, so an oversized file is never
 * pulled into memory. `statSync` follows symlinks, so a symlinked SKILL.md is
 * measured and read through to its target. Callers must have already
 * established that the path exists — an absent SKILL.md is a silent skip (an
 * ordinary subdirectory), not a failure worth reporting.
 */
function readCapped(path: string, maxBytes: number): { ok: string } | { error: string } {
  try {
    const size = statSync(path).size;
    if (size > maxBytes) {
      return {
        error: `SKILL.md is ${size} bytes, over the ${maxBytes}-byte limit (raise settings.skills.maxFileBytes)`,
      };
    }
    return { ok: readFileSync(path, "utf8") };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

interface ParsedSkill {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  body: string;
}

function parseSkillFile(text: string): { ok: ParsedSkill } | { error: string } {
  // The parser is best-effort by contract: it never throws, so the only ways a
  // SKILL.md is rejected are the three genuine identity failures below. A field
  // we don't model (`allowed-tools`, `hooks`, nested `metadata`, …) is carried
  // in the object and ignored rather than failing the file — that is what lets
  // skills authored for other agent runtimes load unchanged.
  const { meta, body, hasFrontMatter } = splitFrontMatter(text);
  if (!hasFrontMatter) return { error: "missing front-matter" };
  const name = frontMatterText(meta["name"]);
  if (name === undefined || !NAME_RE.test(name)) {
    return { error: `invalid or missing name (must match ${NAME_RE.source})` };
  }
  const descRaw = frontMatterText(meta["description"])?.trim();
  if (descRaw === undefined || descRaw.length === 0) {
    return { error: "missing description" };
  }
  // Claude Code semantics: `when_to_use` is optional extra trigger context that
  // is appended to the description, so `description` is the single model-facing
  // string. It is carried verbatim, at whatever length the author wrote: the
  // description is what the model routes on, and truncating it silently drops
  // exactly the trigger keywords that make routing work. The only bound on
  // index text is applied at render time (`renderSkillsBlock`), which caps each
  // entry at `skills.maxDescriptionBytes` and, when the whole block overruns
  // its budget, degrades entries to name-only rather than dropping skills.
  const whenToUse = frontMatterText(meta["when_to_use"])?.trim() ?? "";
  const description = whenToUse ? `${descRaw} ${whenToUse}` : descRaw;
  // Who is allowed to invoke this skill (Claude Code semantics). Unknown values
  // fall back to the permissive default.
  const disableModelInvocation = frontMatterBool(meta["disable-model-invocation"], false);
  const userInvocable = frontMatterBool(meta["user-invocable"], true);
  return {
    ok: { name, description, disableModelInvocation, userInvocable, body: body.trimStart() },
  };
}

interface Target {
  kind: "user" | "project";
  root: string;
  /** Plugin that owns this root, resolved from `pluginRoots` at target build time. */
  pluginRoot?: string;
}

function scan(r: ResolvedOpts, logger: SkillsLogger | undefined): CacheEntry {
  const targets: Target[] = [];
  for (const d of r.projectDirs) targets.push({ kind: "project", root: resolve(r.cwd, d) });
  for (const d of r.userPaths) targets.push({ kind: "user", root: expandHome(d, r.home) });
  for (const d of r.extraDirs) {
    const root = expandHome(d, r.home);
    // Look the plugin up by the caller's spelling *and* the expanded path, so
    // a `~/`-relative extraDir still matches its pluginRoots entry.
    const pluginRoot = r.pluginRoots[d] ?? r.pluginRoots[root];
    targets.push({ kind: "user", root, ...(pluginRoot !== undefined ? { pluginRoot } : {}) });
  }

  const list: SkillListItem[] = [];
  const seen = new Set<string>();

  for (const t of targets) {
    if (!isDir(t.root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(t.root, { withFileTypes: true })
        // `withFileTypes` reports a symlinked directory as a symlink, not a
        // directory, so filtering on isDirectory() alone silently drops skills
        // that were symlinked into place — a normal way to share one skill
        // across checkouts. Resolve those through isDir (statSync) instead.
        .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(join(t.root, e.name))))
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
      const read = readCapped(path, r.maxFileBytes);
      if ("error" in read) {
        logger?.warn({ path, err: read.error }, "skill parse failed");
        continue;
      }
      const parsed = parseSkillFile(read.ok);
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
        ...(t.pluginRoot !== undefined ? { pluginRoot: t.pluginRoot } : {}),
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
  /** Owning plugin's root, when the skill came from a plugin. */
  pluginRoot?: string;
}

export function getSkill(
  input: { name: string },
  opts?: SkillsOptions,
): LoadedSkill | undefined {
  const item = ensureScanned(opts).list.find((s) => s.name === input.name);
  if (!item) return undefined;
  // Re-read rather than serving a cached body, so an edit lands without a
  // rescan — which also means the size cap has to be re-applied here: the file
  // may have grown past it since the scan that indexed it.
  const read = readCapped(join(item.location, "SKILL.md"), resolveOpts(opts).maxFileBytes);
  if ("error" in read) return undefined;
  const parsed = parseSkillFile(read.ok);
  if ("error" in parsed) return undefined;
  return {
    body: parsed.ok.body,
    location: item.location,
    ...(item.pluginRoot !== undefined ? { pluginRoot: item.pluginRoot } : {}),
  };
}

/** Exported for tests; not part of the public API. */
export function _resetSkillsCacheForTests(): void {
  cache.clear();
}
