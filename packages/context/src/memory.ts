import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_MEMORY_FILENAMES } from "@nova/runtime";

export type MemoryLayer = "global" | "user" | "project";

export interface MemorySource {
  layer: MemoryLayer;
  path: string;
  filename: string;
}

export interface MemoryBundle {
  system: string;
  sources: MemorySource[];
}

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
  return `<memory layer="${src.layer}" path="${src.path}">\n${body.trimEnd()}\n</memory>`;
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

  return {
    system: bodies.join("\n\n"),
    sources,
  };
}
