import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { xmlAttr, xmlEscape } from "@nova/core";
import { DEFAULT_AUTO_MEMORY_MAX_ENTRIES, DEFAULT_MEMORY_FILENAMES } from "@nova/runtime";

export type MemoryLayer = "global" | "user" | "project" | "auto";

export interface MemorySource {
  layer: MemoryLayer;
  path: string;
  filename: string;
}

export interface MemoryBundle {
  system: string;
  sources: MemorySource[];
  /**
   * Resolved absolute directory of the project-scoped auto-memory store, echoed
   * back when `LoadMemoryOptions.autoDir` is set (i.e. the feature is enabled),
   * independent of whether an index file exists yet. `buildSystemPrompt` uses it
   * to tell the model where to write/read memories.
   */
  autoDir?: string;
}

/** Index file the agent maintains at the root of the auto-memory directory. */
export const MEMORY_INDEX_FILENAME = "MEMORY.md";

export interface LoadMemoryOptions {
  /**
   * Filenames to probe at every project directory (highest priority first).
   * Defaults to NOVA.md > CLAUDE.md > AGENTS.md.
   */
  filenames?: readonly string[];
  /**
   * Candidate absolute paths for the single user-layer memory file. The
   * first existing entry wins. Defaults to the spec list:
   *   ~/.nova/NOVA.md → ~/.claude/CLAUDE.md → ~/.config/agents/AGENTS.md
   */
  userPaths?: readonly string[];
  /**
   * Optional absolute path to a built-in global memory file. Skipped when
   * unset or missing.
   */
  globalPath?: string;
  /**
   * Absolute directory of the project-scoped auto-memory store. When set, the
   * agent-maintained `MEMORY.md` index there (if present) is loaded as the
   * `auto` layer, and the bundle echoes the dir back so the system prompt can
   * teach the model to read/write memories under it. Unset disables the feature.
   */
  autoDir?: string;
  /**
   * Upper bound on how many memory entries (index lines) of `MEMORY.md` are
   * injected, since the index ships in the system prompt on every request.
   * Surplus entries are dropped with a pointer to the full file. Defaults to
   * DEFAULT_AUTO_MEMORY_MAX_ENTRIES.
   */
  autoMaxEntries?: number;
  /**
   * Override the user's home directory (used by tests).
   */
  home?: string;
}

const DEFAULT_FILENAMES: readonly string[] = DEFAULT_MEMORY_FILENAMES;

function defaultUserPaths(home: string): string[] {
  return [
    join(home, ".nova", "NOVA.md"),
    join(home, ".claude", "CLAUDE.md"),
    join(home, ".config", "agents", "AGENTS.md"),
  ];
}

async function fileExists(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  return !!s && s.isFile();
}

async function dirExists(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  return !!s && s.isDirectory();
}

async function readUtf8(p: string): Promise<string> {
  return (await readFile(p, "utf8")).replace(/\r\n/g, "\n");
}

/**
 * Walk upward from `start` until — and including — a directory that contains
 * `.git`. Falls back to the filesystem root when no `.git` is found.
 */
async function collectProjectDirs(start: string): Promise<string[]> {
  const dirs: string[] = [];
  let current = resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    dirs.push(current);
    if (await dirExists(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

async function pickProjectFile(
  dir: string,
  filenames: readonly string[],
): Promise<MemorySource | null> {
  for (const filename of filenames) {
    const full = join(dir, filename);
    if (await fileExists(full)) {
      return { layer: "project", path: full, filename };
    }
  }
  return null;
}

async function pickUserFile(candidates: readonly string[]): Promise<MemorySource | null> {
  for (const candidate of candidates) {
    const full = isAbsolute(candidate) ? candidate : resolve(candidate);
    if (await fileExists(full)) {
      const filename = full.split("/").pop() ?? full;
      return { layer: "user", path: full, filename };
    }
  }
  return null;
}

async function pickGlobalFile(path: string | undefined): Promise<MemorySource | null> {
  if (!path) return null;
  const full = isAbsolute(path) ? path : resolve(path);
  if (!(await fileExists(full))) return null;
  const filename = full.split("/").pop() ?? full;
  return { layer: "global", path: full, filename };
}

function renderSection(src: MemorySource, body: string): string {
  return (
    `<memory layer="${xmlAttr(src.layer)}" path="${xmlAttr(src.path)}">\n` +
    `${xmlEscape(body.trimEnd())}\n</memory>`
  );
}

/** A MEMORY.md line that represents one memory entry (a markdown list item). */
function isEntryLine(line: string): boolean {
  return /^\s*-\s/.test(line);
}

/**
 * Bound the injected index to its `maxEntries` NEWEST memory entries. The writer
 * convention (see the memory-instructions prompt) appends new pointers to the
 * END of MEMORY.md, so the newest entries are the trailing ones — we keep those
 * and drop the oldest from the top. Leading non-entry lines (the heading/blanks)
 * are preserved; a pointer to the full file marks where the older ones were cut.
 * Lossless in practice: the model can `read` the complete MEMORY.md via baseDir.
 */
function capIndexBody(body: string, maxEntries: number): string {
  const lines = body.split("\n");
  const entryIdxs = lines.flatMap((line, i) => (isEntryLine(line) ? [i] : []));
  const dropped = entryIdxs.length - maxEntries;
  if (dropped <= 0) return body;

  const firstEntryIdx = entryIdxs[0];
  const firstKeptIdx = entryIdxs[dropped]; // (dropped)th entry = first survivor
  if (firstEntryIdx === undefined || firstKeptIdx === undefined) return body;

  const header = lines.slice(0, firstEntryIdx); // heading + blanks before entries
  const tail = lines.slice(firstKeptIdx); // newest maxEntries entries (+ trailing)
  const noun = dropped === 1 ? "memory" : "memories";
  const notice =
    `<!-- ${dropped} older ${noun} omitted to bound the prompt; ` +
    `read ${MEMORY_INDEX_FILENAME} for the full index -->`;
  return [...header, notice, ...tail].join("\n");
}

/**
 * The auto layer is an INDEX pointing at sibling memory files, not a single
 * self-contained doc, so it carries `baseDir` (instead of `path`): the model
 * resolves each index link against it to `read` a memory's full text.
 */
function renderAutoSection(baseDir: string, body: string): string {
  return (
    `<memory layer="auto" baseDir="${xmlAttr(baseDir)}">\n` +
    `${xmlEscape(body.trimEnd())}\n</memory>`
  );
}

/**
 * Load the three-layer memory bundle. Order in the returned `system` string
 * (and `sources`) is global → user → project (outer project dirs before
 * inner), so later entries naturally override earlier ones when the model
 * reads them top-to-bottom.
 */
export async function loadMemory(
  cwd: string = process.cwd(),
  opts: LoadMemoryOptions = {},
): Promise<MemoryBundle> {
  const filenames = opts.filenames ?? DEFAULT_FILENAMES;
  const home = opts.home ?? homedir();
  const userCandidates = opts.userPaths ?? defaultUserPaths(home);

  const sources: MemorySource[] = [];
  const bodies: string[] = [];

  const globalSrc = await pickGlobalFile(opts.globalPath);
  if (globalSrc) {
    sources.push(globalSrc);
    bodies.push(renderSection(globalSrc, await readUtf8(globalSrc.path)));
  }

  const userSrc = await pickUserFile(userCandidates);
  if (userSrc) {
    sources.push(userSrc);
    bodies.push(renderSection(userSrc, await readUtf8(userSrc.path)));
  }

  // Project layer: walk root → cwd so deeper memory appears last (overrides).
  const dirs = (await collectProjectDirs(cwd)).slice().reverse();
  for (const dir of dirs) {
    const projectSrc = await pickProjectFile(dir, filenames);
    if (projectSrc) {
      sources.push(projectSrc);
      bodies.push(renderSection(projectSrc, await readUtf8(projectSrc.path)));
    }
  }

  // Auto layer last: the agent's own learned notes are the most specific, and
  // the index points at sibling files rather than inlining their content.
  if (opts.autoDir) {
    const indexPath = join(opts.autoDir, MEMORY_INDEX_FILENAME);
    if (await fileExists(indexPath)) {
      const autoSrc: MemorySource = {
        layer: "auto",
        path: indexPath,
        filename: MEMORY_INDEX_FILENAME,
      };
      sources.push(autoSrc);
      const maxEntries = opts.autoMaxEntries ?? DEFAULT_AUTO_MEMORY_MAX_ENTRIES;
      const indexBody = capIndexBody(await readUtf8(indexPath), maxEntries);
      bodies.push(renderAutoSection(opts.autoDir, indexBody));
    }
  }

  return {
    system: bodies.join("\n\n"),
    sources,
    // Echoed even when the index file doesn't exist yet, so the prompt can still
    // teach the model where to create the first memory.
    ...(opts.autoDir ? { autoDir: opts.autoDir } : {}),
  };
}
