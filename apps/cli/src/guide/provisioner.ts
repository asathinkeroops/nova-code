import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Logger } from "@nova/runtime";

const execFileP = promisify(execFile);

export interface GuideProvisionOptions {
  /** Git URL to clone (settings.guide.repoUrl). */
  repoUrl: string;
  /** Branch to track (settings.guide.ref). */
  ref: string;
  /** Target checkout dir (settings.guide.cacheDir); may use `~` or be relative. */
  cacheDir: string;
  /**
   * Freshness window in milliseconds. When set and > 0, an existing checkout
   * refreshed more recently than this is left untouched (no network fetch) —
   * throttles the every-launch background warm. Omit or 0 to always refresh.
   * Ignored for the initial clone (there is nothing to serve yet).
   */
  maxAgeMs?: number;
  /** Home dir override (tests); defaults to os.homedir(). */
  home?: string;
  logger?: Logger;
}

export interface GuideProvisionResult {
  /** Absolute path to the checkout the guide reads. */
  dir: string;
  /** True when we fetched from the network this run (a clone or successful pull). */
  refreshed: boolean;
  /** True when a network refresh failed but an existing checkout was reused. */
  offline: boolean;
}

/** A provisioning failure that leaves no usable checkout to fall back to. */
export class GuideProvisionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GuideProvisionError";
  }
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Resolve the configured cacheDir to an absolute path. `~`/`~/…` expand to the
 * home dir; a still-relative path is anchored at home (not cwd) so the guide
 * checkout lives beside nova.config.json regardless of where nova was launched.
 */
export function resolveGuideDir(cacheDir: string, home: string = homedir()): string {
  const expanded = expandHome(cacheDir, home);
  return isAbsolute(expanded) ? expanded : join(home, expanded);
}

/** The `guide` settings this module needs to locate the source checkout. */
export interface GuideSourceSettings {
  source: "remote" | "local";
  cacheDir: string;
  localPath?: string | undefined;
}

/**
 * Resolve the directory the guide reads, honoring `source`:
 *  - "remote" → the remote clone dir ({@link resolveGuideDir} on `cacheDir`).
 *  - "local"  → `localPath` (relative paths resolve against `workspace`, `~`
 *    against home), or `workspace` itself when `localPath` is unset.
 *
 * Callers still branch on `source` to decide whether to provision (remote) or
 * just read (local); this only computes the path both agree on.
 */
export function resolveGuideSourceDir(
  s: GuideSourceSettings,
  workspace: string,
  home: string = homedir(),
): string {
  if (s.source === "local") {
    const p = s.localPath?.trim();
    if (!p) return workspace;
    const expanded = expandHome(p, home);
    return isAbsolute(expanded) ? expanded : resolve(workspace, expanded);
  }
  return resolveGuideDir(s.cacheDir, home);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

async function isGitRepo(dir: string): Promise<boolean> {
  const s = await stat(join(dir, ".git")).catch(() => null);
  return !!s && s.isDirectory();
}

// Marker recording the last successful refresh. Lives inside `.git/` so `git
// reset --hard` / `git clean -fdq` (which only touch the work tree) never wipe
// it. Its mtime is the "last refreshed at" clock the TTL check reads.
function stampPath(dir: string): string {
  return join(dir, ".git", "nova-guide-refresh");
}

async function refreshAgeMs(dir: string): Promise<number> {
  const s = await stat(stampPath(dir)).catch(() => null);
  return s ? Date.now() - s.mtimeMs : Number.POSITIVE_INFINITY;
}

async function writeStamp(dir: string): Promise<void> {
  await writeFile(stampPath(dir), new Date().toISOString()).catch(() => {});
}

async function git(cwd: string, args: readonly string[], logger?: Logger): Promise<void> {
  logger?.debug({ args }, "nova-code-guide: git");
  try {
    // The guide checkout is warmed fire-and-forget on startup, so its git child
    // must never keep the process alive: unref the child and its stdio pipes so
    // an in-flight clone/fetch can't block `/exit` (the process leaves it to
    // finish orphaned). Harmless for the interactive `/nova-code-guide` path —
    // the REPL keeps the loop alive there, so the await still settles normally.
    const p = execFileP("git", [...args], { cwd });
    const child = (p as unknown as { child?: import("node:child_process").ChildProcess }).child;
    if (child) {
      // The stdio pipes are Sockets at runtime (they carry `.unref`) but typed
      // as Readable/Writable, so reach for it through a cast.
      const unref = (s: unknown): void =>
        (s as { unref?: () => void } | null | undefined)?.unref?.();
      child.unref();
      unref(child.stdin);
      unref(child.stdout);
      unref(child.stderr);
    }
    await p;
  } catch (err) {
    if (isEnoent(err)) {
      throw new GuideProvisionError(
        "git was not found on PATH — install git to use /nova-code-guide.",
        { cause: err },
      );
    }
    throw err;
  }
}

// De-dupe concurrent provisioning of the same checkout: a second /nova-code-guide
// fired while the first clone/pull is still running joins the in-flight promise
// instead of racing git in the same directory.
const inflight = new Map<string, Promise<GuideProvisionResult>>();

/**
 * Ensure the Nova source checkout at `cacheDir` exists and is up to date, then
 * return its absolute path. First run shallow-clones `repoUrl`#`ref`; subsequent
 * runs shallow-fetch and hard-reset onto the ref so the checkout mirrors origin.
 *
 * A network failure during an *update* degrades gracefully: the prior checkout
 * is reused and `offline: true` is returned (the guide can still answer, just
 * from slightly stale source). A failure during the *initial* clone throws
 * {@link GuideProvisionError} — there is nothing to fall back to.
 */
export function ensureFresh(opts: GuideProvisionOptions): Promise<GuideProvisionResult> {
  const home = opts.home ?? homedir();
  const dir = resolveGuideDir(opts.cacheDir, home);
  const existing = inflight.get(dir);
  if (existing) return existing;
  const run = provision(dir, opts).finally(() => inflight.delete(dir));
  inflight.set(dir, run);
  return run;
}

async function provision(dir: string, opts: GuideProvisionOptions): Promise<GuideProvisionResult> {
  const { repoUrl, ref, logger } = opts;

  if (await isGitRepo(dir)) {
    // Throttle: if the checkout was refreshed within the freshness window, skip
    // the network entirely and serve it as-is (keeps the every-launch warm cheap).
    const { maxAgeMs } = opts;
    if (maxAgeMs !== undefined && maxAgeMs > 0 && (await refreshAgeMs(dir)) < maxAgeMs) {
      return { dir, refreshed: false, offline: false };
    }
    // Update in place: shallow-fetch the tracked ref and hard-reset onto it,
    // then drop stray untracked files so the tree mirrors origin exactly.
    try {
      await git(dir, ["fetch", "--depth", "1", "origin", ref], logger);
      await git(dir, ["reset", "--hard", "FETCH_HEAD"], logger);
      await git(dir, ["clean", "-fdq"], logger);
      await writeStamp(dir);
      return { dir, refreshed: true, offline: false };
    } catch (err) {
      // Most likely offline / transient network failure (or missing git). The
      // existing checkout is still valid, so answer from it rather than failing.
      logger?.warn(
        { err: errMsg(err), dir },
        "nova-code-guide: refresh failed, using cached checkout",
      );
      return { dir, refreshed: false, offline: true };
    }
  }

  // No checkout yet: shallow-clone into a staging dir and rename into place, so
  // an interrupted clone never leaves a half-populated cache dir behind.
  await mkdir(dirname(dir), { recursive: true });
  const staging = `${dir}.staging`;
  await rm(staging, { recursive: true, force: true });
  try {
    await git(dirname(dir), ["clone", "--depth", "1", "--branch", ref, repoUrl, staging], logger);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (err instanceof GuideProvisionError) throw err;
    throw new GuideProvisionError(
      `failed to clone the Nova source from ${repoUrl} (${errMsg(err)}). ` +
        `Check your network connection and that git is installed.`,
      { cause: err },
    );
  }
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
  await writeStamp(dir);
  return { dir, refreshed: true, offline: false };
}
