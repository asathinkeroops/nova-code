import { execFile } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalizePath } from "@nova/base";
import ignore from "ignore";

/**
 * Host-side git worktree plumbing.
 *
 * Everything here runs `git` directly (never through the `bash` tool): creating
 * or removing a worktree writes the repository's shared `.git` metadata, which
 * the OS sandbox confines away from the workspace. Running it here also keeps
 * the operation out of the model's permission flow — the user asked for it.
 *
 * The file is deliberately I/O-only and free of UI: the `/worktree` command and
 * `--worktree` both call in, and the pure helpers (`parseWorktreeList`,
 * `sanitizeWorktreeName`, `planAddWorktree`) are unit-testable without a repo.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git, never throwing: a non-zero exit is data the caller inspects. */
export async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return await new Promise<GitResult>((resolvePromise) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0;
        resolvePromise({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/** A directory that is inside a git work tree, or undefined. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  const r = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : undefined;
}

/** Absolute path of the repository's shared git dir (`<main>/.git`). */
export async function gitCommonDir(dir: string): Promise<string | undefined> {
  const r = await runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : undefined;
}

/**
 * The identity two checkouts share exactly when they belong to the same
 * repository — used to decide whether a session may move between them.
 *
 * It is the shared git dir, NOT the main checkout path: `git init
 * --separate-git-dir` puts the common dir outside every checkout, and a linked
 * worktree then has no nameable main checkout (`mainCheckoutRoot` returns
 * undefined), even though both directories are obviously the same repository.
 * Canonicalized because git reports absolute but not necessarily
 * symlink-resolved paths, and the session workspace may have been launched
 * through one (macOS `/tmp` → `/private/tmp`).
 */
export async function repoIdentity(dir: string, gitDir?: string): Promise<string | undefined> {
  const common = gitDir ?? (await gitCommonDir(dir));
  if (!common) return undefined;
  return canonicalizePath(dir, common);
}

/**
 * The repository's MAIN working tree — the checkout new worktrees hang off —
 * or undefined when the git metadata cannot name it.
 *
 * `dirname(gitCommonDir)` is not enough: with `git init --separate-git-dir` the
 * common dir lives outside every checkout, so its parent is a metadata
 * directory — git itself even lists the git dir as the "main worktree" there.
 * The checkout's own `.git` entry is the reliable signal:
 *
 *  - a directory → the conventional main checkout;
 *  - a `gitdir:` file whose target IS the common dir → the separate-git-dir
 *    MAIN checkout;
 *  - a `gitdir:` file pointing into `<common>/worktrees/…` → a linked
 *    worktree, whose main checkout is `dirname(common)` only when that
 *    directory really is a checkout (the conventional layout).
 *
 * The remaining combination — separate git dir + linked worktree — cannot be
 * resolved from git metadata at all; this returns undefined and callers refuse
 * instead of running git in a metadata directory.
 */
/**
 * What a checkout IS, judged by its own `.git` entry:
 *
 *  - "main"    — its git dir is the shared/common dir (conventional checkout,
 *                or the `--separate-git-dir` main checkout);
 *  - "linked"  — its git dir lives under `<common>/worktrees/<name>`;
 *  - "unknown" — anything else (no `.git`, unreadable, bare, …).
 */
async function classifyCheckout(
  topAbs: string,
  commonAbs: string,
): Promise<"main" | "linked" | "unknown"> {
  const dotGit = join(topAbs, ".git");
  const entry = await stat(dotGit).catch(() => null);
  if (entry?.isDirectory()) return resolve(dotGit) === commonAbs ? "main" : "unknown";
  if (!entry?.isFile()) return "unknown";

  const text = await readFile(dotGit, "utf8").catch(() => "");
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match?.[1]) return "unknown";
  const target = resolve(topAbs, match[1].trim());
  if (target === commonAbs) return "main";
  return target.startsWith(`${join(commonAbs, "worktrees")}${sep}`) ? "linked" : "unknown";
}

export async function mainCheckoutRoot(dir: string): Promise<string | undefined> {
  const top = await repoRoot(dir);
  const common = await gitCommonDir(dir);
  if (!top || !common) return undefined;
  const topAbs = resolve(top);
  const commonAbs = resolve(common);

  const kind = await classifyCheckout(topAbs, commonAbs);
  if (kind === "main") return topAbs;
  if (kind !== "linked") return undefined;

  // Linked worktree: the conventional layout keeps the main checkout beside the
  // shared git dir. Anything else (a separate git dir) cannot be derived.
  const candidate = dirname(commonAbs);
  const candidateGit = await stat(join(candidate, ".git")).catch(() => null);
  return candidateGit ? candidate : undefined;
}

export async function currentBranch(dir: string): Promise<string | null> {
  const r = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const out = r.stdout.trim();
  return r.code === 0 && out && out !== "HEAD" ? out : null;
}

export interface WorktreeBinding {
  /** The checkout this session's tools run in (a linked worktree). */
  path: string;
  /**
   * The main checkout it shares history with — ABSENT when git metadata cannot
   * name it (a separate git dir combined with a linked worktree). The isolation
   * guard then falls back to classifying each target against `gitDir`, which
   * still identifies "a main working tree of this repository" exactly.
   */
  main?: string;
  branch?: string;
  /**
   * The repository's shared git directory — `git rev-parse --git-common-dir`.
   * Objects, refs and this checkout's own `worktrees/<name>/index` all live
   * here. Not always `<main>/.git`: `git init --separate-git-dir` (and other
   * layouts) put it elsewhere, which is why the sandbox allowlist reads this
   * instead of assuming the conventional path.
   */
  gitDir: string;
  /**
   * Every OTHER checkout of the repository (the main one excluded).
   *
   * Worktrees normally live *inside* the repository root (`.nova/worktrees/…`),
   * so a plain "is this path under the main checkout?" test would flag the
   * worktree itself. Isolation checks subtract these roots before deciding.
   */
  checkouts: string[];
}

/**
 * Describe `dir` when it is a LINKED worktree (its own `.git` file pointing at
 * another checkout's metadata). Returns undefined for a normal checkout, a
 * non-repo, or any git failure — callers treat "undefined" as "no isolation".
 */
export async function worktreeBinding(dir: string): Promise<WorktreeBinding | undefined> {
  const top = await repoRoot(dir);
  const common = await gitCommonDir(dir);
  if (!top || !common) return undefined;
  const topAbs = resolve(top);
  const commonAbs = resolve(common);

  // Only a LINKED worktree gets a binding. That is decidable from the checkout's
  // own `.git` entry even when the main checkout is not — which is what keeps the
  // isolation guard alive in the `--separate-git-dir` layout.
  if ((await classifyCheckout(topAbs, commonAbs)) !== "linked") return undefined;

  const main = await mainCheckoutRoot(topAbs);
  const mainAbs = main ? resolve(main) : undefined;
  if (mainAbs === topAbs) return undefined;

  const branch = await currentBranch(topAbs);
  const checkouts = (await listWorktrees(topAbs))
    .map((w) => resolve(w.path))
    // The shared git dir itself is listed as the "main worktree" when
    // `core.worktree` is unset; it is metadata, not a checkout.
    .filter((p) => p !== commonAbs && p !== topAbs && p !== mainAbs);
  return {
    path: topAbs,
    ...(mainAbs ? { main: mainAbs } : {}),
    gitDir: commonAbs,
    ...(branch ? { branch } : {}),
    checkouts,
  };
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Records are blank-line separated `key value` lines; the first record is the
 * main checkout. A worktree is listed by path even when it is locked or its
 * branch is gone, which is exactly what `/worktree` needs to show.
 */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = {
        path: value,
        branch: null,
        head: null,
        detached: false,
        bare: false,
        locked: false,
      };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") current.locked = true;
  }
  if (current) entries.push(current);
  return entries;
}

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const r = await runGit(repo, ["worktree", "list", "--porcelain"]);
  return r.code === 0 ? parseWorktreeList(r.stdout) : [];
}

/**
 * A worktree directory name: conservative on purpose, because it becomes both
 * a path segment and (prefixed) a branch name. Returns undefined when the input
 * cannot be used as-is — the caller reports that rather than silently mangling
 * it into something the user did not ask for.
 */
export function sanitizeWorktreeName(raw: string): string | undefined {
  const name = raw.trim();
  if (!name || name.length > 64) return undefined;
  if (name === "." || name === ".." || name.startsWith(".")) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  return name;
}

/** Branch a new worktree is created on. */
export function worktreeBranchName(name: string): string {
  return `worktree-${name}`;
}

/** Absolute path for a new worktree: `<repo>/<dir>/<name>`. */
export function worktreePathFor(repo: string, dir: string, name: string): string {
  return resolve(repo, dir, name);
}

/**
 * Extra OS-sandbox write paths a worktree session needs.
 *
 * A linked worktree keeps everything mutable in the repository's SHARED git
 * dir (objects, refs, plus this checkout's own `worktrees/<name>/index`), which
 * lies outside the worktree path — so it has to join the sandbox allowlist or
 * `git add`/`git commit` fail with EPERM on `index.lock`. The path comes from
 * `git rev-parse --git-common-dir` rather than `<main>/.git`, so a repository
 * created with `--separate-git-dir` works too. Outside a worktree the workspace
 * already contains its git dir, so there is nothing extra to add.
 *
 * (Verified against @anthropic-ai/sandbox-runtime on macOS: without this entry
 * `git commit` is denied; with it the commit succeeds even though the SDK keeps
 * `.git/hooks` and the other mandatory deny patterns.)
 */
export function sandboxGitAllowWrite(worktree: Pick<WorktreeBinding, "gitDir"> | null): string[] {
  return worktree ? [worktree.gitDir] : [];
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface AddWorktreeOptions {
  /**
   * The checkout nova is running in — the main checkout or any linked worktree.
   * The checkout is PLACED under the main checkout's root; its start point is
   * read from this directory.
   */
  repo: string;
  name: string;
  /** Base directory relative to the repository root, e.g. `.nova/worktrees`. */
  dir: string;
  /** `fresh` starts from origin/HEAD when it resolves locally, else HEAD. */
  baseRef: "head" | "fresh";
  /** Explicit start point (branch / tag / commit). Overrides `baseRef`. */
  from?: string;
  /** Copy gitignored files listed in this repo-relative file (best effort). */
  includeFile?: string;
}

export interface AddWorktreeResult {
  path: string;
  branch: string;
  /** false when an existing registered worktree at that path was reused. */
  created: boolean;
  /** Gitignored files copied in (0 when there was nothing to copy). */
  copied: number;
  /** Candidates left alone because copying them would clobber tracked content. */
  skipped: number;
  /** Candidates that matched and passed the target checks but could not be copied. */
  failed: number;
}

/**
 * Resolve the commit a new worktree should start from, reading every revision
 * in the checkout nova was LAUNCHED in.
 *
 * `git worktree add` runs in the main checkout (that is where the registry
 * lives), so a bare `HEAD` there is the main checkout's — not the one the user
 * is looking at. Resolving to a commit SHA up front keeps `baseRef: "head"`
 * meaning "my current work", however deep in a worktree the command ran.
 */
async function resolveStartPoint(opts: AddWorktreeOptions, checkout: string): Promise<string> {
  const revParse = async (rev: string): Promise<string | undefined> => {
    const r = await runGit(checkout, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  };

  if (opts.from) {
    if (opts.from.startsWith("-")) {
      throw new WorktreeError(`invalid start point "${opts.from}" — it looks like an option`);
    }
    const sha = await revParse(opts.from);
    if (!sha) {
      throw new WorktreeError(`start point "${opts.from}" is not a commit in ${checkout}`);
    }
    return sha;
  }

  if (opts.baseRef === "fresh") {
    // Never fetch here: `git worktree add` would inherit an interactive
    // credential prompt and hang the TUI. A stale cached origin/HEAD still
    // produces a correct checkout, just not the newest one.
    const origin = await revParse("origin/HEAD");
    if (origin) return origin;
  }
  const head = await revParse("HEAD");
  if (!head) throw new WorktreeError(`cannot resolve HEAD in ${checkout}`);
  return head;
}

/**
 * Create (or re-open) a worktree. Idempotent by name: if a worktree is already
 * registered at the computed path, it is returned untouched — that is what
 * makes `nova --worktree fix` safe to re-run and `/worktree new` a no-op when
 * the user forgets they already made one.
 *
 * Two different roots are involved, and conflating them was a bug:
 *
 *  - the LAYOUT root (where the checkout is placed, which registry it joins)
 *    is always the repository's MAIN checkout — a worktree created from inside
 *    another worktree used to land in `<worktree>/.nova/worktrees/...`, and
 *    reopening it by name could not find the existing one;
 *  - the START POINT is read in the checkout nova was launched in, so
 *    `baseRef: "head"` keeps meaning "the work I am looking at" rather than
 *    silently switching to the main checkout's HEAD.
 */
export async function addWorktree(opts: AddWorktreeOptions): Promise<AddWorktreeResult> {
  const checkout = await repoRoot(opts.repo);
  if (!checkout) throw new WorktreeError(`not a git repository: ${opts.repo}`);
  const layoutRoot = await mainCheckoutRoot(checkout);
  if (!layoutRoot) {
    throw new WorktreeError(
      `cannot locate the main checkout of ${checkout}: this repository keeps its git directory ` +
        `outside the working tree, so nova cannot tell where a new worktree belongs. Create it ` +
        `with \`git worktree add <path> -b <branch>\` and run \`nova --cwd <path>\`.`,
    );
  }

  const name = sanitizeWorktreeName(opts.name);
  if (!name) {
    throw new WorktreeError(
      `invalid worktree name "${opts.name}" — use letters, digits, ".", "_" or "-" (max 64 chars, no leading dot)`,
    );
  }
  const path = worktreePathFor(layoutRoot, opts.dir, name);
  const branch = worktreeBranchName(name);

  const existing = (await listWorktrees(layoutRoot)).find((w) => resolve(w.path) === resolve(path));
  if (existing) {
    return {
      path,
      branch: existing.branch ?? branch,
      created: false,
      copied: 0,
      skipped: 0,
      failed: 0,
    };
  }
  const collided = await stat(path).catch(() => null);
  if (collided) {
    throw new WorktreeError(
      `${path} already exists but is not a worktree of ${layoutRoot} — remove it or pick another name`,
    );
  }

  const branchExists =
    (await runGit(layoutRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]))
      .code === 0;
  // Resolve the start point BEFORE touching the filesystem, so a bad `from`
  // leaves nothing behind (not even the parent directory).
  const startPoint = branchExists ? undefined : await resolveStartPoint(opts, checkout);

  await mkdir(dirname(path), { recursive: true });

  const args = ["worktree", "add"];
  if (!branchExists) {
    args.push("-b", branch);
  }
  args.push(path);
  if (branchExists) {
    args.push(branch);
  } else if (startPoint) {
    args.push(startPoint);
  }

  const created = await runGit(layoutRoot, args);
  if (created.code !== 0) {
    throw new WorktreeError(
      `git worktree add failed: ${(created.stderr || created.stdout).trim().split("\n")[0] ?? "unknown error"}`,
    );
  }

  // Keep the checkout out of the main checkout's `git status`, and out of any
  // `git add -A`. `info/exclude` is shared by every worktree of the repo.
  await ensureRepoExcludes(layoutRoot, [`/${opts.dir.replace(/\/+$/, "")}/`, "/.tasks/"]);

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  if (opts.includeFile) {
    // Copy candidates come from the LAUNCH checkout — that is where the local
    // `.env` / ignored config lives. The target-side checks run in `path`.
    ({ copied, skipped, failed } = await copyIncludedFiles({
      repo: checkout,
      worktree: path,
      includeFile: opts.includeFile,
    }));
  }

  return { path, branch, created: true, copied, skipped, failed };
}

/**
 * Append patterns to the repository's `info/exclude` (idempotent). This is
 * shared metadata, never a committed file, so it cannot leak into the user's
 * repo history — but it is also not per-worktree, which is what we want:
 * one entry hides every checkout.
 */
export async function ensureRepoExcludes(repo: string, patterns: readonly string[]): Promise<void> {
  const r = await runGit(repo, ["rev-parse", "--git-path", "info/exclude"]);
  const raw = r.stdout.trim();
  if (r.code !== 0 || !raw) return;
  const file = isAbsolute(raw) ? raw : resolve(repo, raw);
  const existing = await readFile(file, "utf8").catch(() => "");
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = patterns.filter((p) => !present.has(p));
  if (missing.length === 0) return;
  const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${prefix}${missing.join("\n")}\n`, "utf8");
}

/**
 * Copy the gitignored files named by `.worktreeinclude` (a `.gitignore`-syntax
 * file at the repository root) into a freshly created worktree.
 *
 * Candidates come from the SOURCE checkout, but the decision to copy is made
 * against the TARGET checkout, because "ignored" is a property of the branch:
 *
 *  - a path tracked at the target's start commit is never touched — it used to
 *    be possible to overwrite it with a locally-ignored file (secrets included,
 *    since a later `git add -A` would commit them);
 *  - an existing destination is never overwritten;
 *  - a path the target's ignore rules do NOT cover is skipped too, since it
 *    would show up as untracked (and be committed) in the fresh checkout.
 *
 * Everything skipped or failed is counted so the caller can report it instead of
 * silently dropping files — a copy that throws must never look like a copy that
 * happened.
 */
export async function copyIncludedFiles(opts: {
  repo: string;
  worktree: string;
  includeFile: string;
}): Promise<{ copied: number; skipped: number; failed: number }> {
  const spec = await readFile(resolve(opts.repo, opts.includeFile), "utf8").catch(() => undefined);
  if (!spec) return { copied: 0, skipped: 0, failed: 0 };
  const matcher = ignore().add(spec);
  // The worktree usually lives inside the repo, and its files are ignored too
  // (they match the `info/exclude` entry). Copying a pattern like `**` would
  // then recurse the checkout into itself — never descend into it.
  const worktreeRel = relative(opts.repo, opts.worktree).split(sep).join("/");
  const nested = worktreeRel && !worktreeRel.startsWith("..") ? `${worktreeRel}/` : undefined;
  // `--exclude-standard` covers .gitignore, .git/info/exclude and the global
  // excludes file — the same set that keeps these files out of the checkout.
  const listed = await runGit(opts.repo, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  if (listed.code !== 0) return { copied: 0, skipped: 0, failed: 0 };

  // What the TARGET tracks and ignores. One `ls-files` call for the set;
  // `check-ignore` is per candidate (include lists are tiny by construction).
  const trackedOut = await runGit(opts.worktree, ["ls-files", "-z"]);
  const tracked = new Set(
    trackedOut.code === 0 ? trackedOut.stdout.split("\0").filter(Boolean) : [],
  );

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  for (const rel of listed.stdout.split("\0")) {
    if (!rel || !matcher.ignores(rel)) continue;
    if (nested && rel.startsWith(nested)) continue;
    if (tracked.has(rel)) {
      skipped += 1; // tracked at the target's start commit — copying would clobber it
      continue;
    }
    const dest = join(opts.worktree, rel);
    if (
      await stat(dest).then(
        () => true,
        () => false,
      )
    ) {
      skipped += 1; // never overwrite an existing checkout file
      continue;
    }
    const ignored = await runGit(opts.worktree, ["check-ignore", "-q", "--", rel]);
    if (ignored.code !== 0) {
      skipped += 1; // the target does not ignore it — it would surface as untracked
      continue;
    }
    try {
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(opts.repo, rel), dest, { preserveTimestamps: true });
      copied += 1;
    } catch {
      // A vanished / unreadable ignored file must not fail worktree creation —
      // but it is NOT a copy, and the caller has to be able to say so.
      failed += 1;
    }
  }
  return { copied, skipped, failed };
}

/**
 * Number of changed + untracked paths in a checkout: `0` = clean, `-1` = could
 * not determine (not a repository, git missing, permission error).
 *
 * The unknown case must stay distinguishable from "clean": a caller that wants
 * to delete the checkout should never treat "I couldn't look" as "there is
 * nothing to lose".
 */
export async function worktreeChangeCount(path: string): Promise<number> {
  const r = await runGit(path, ["status", "--porcelain=v1"]);
  if (r.code !== 0) return -1;
  return r.stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

export async function removeWorktree(opts: {
  repo: string;
  path: string;
  force?: boolean;
}): Promise<void> {
  const args = ["worktree", "remove"];
  if (opts.force) args.push("--force");
  args.push(opts.path);
  const r = await runGit(opts.repo, args);
  if (r.code !== 0) {
    throw new WorktreeError(
      `git worktree remove failed: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? "unknown error"}`,
    );
  }
  await runGit(opts.repo, ["worktree", "prune"]);
}

export async function pruneWorktrees(repo: string): Promise<string> {
  const r = await runGit(repo, ["worktree", "prune", "-v"]);
  return (r.stdout || r.stderr).trim();
}
