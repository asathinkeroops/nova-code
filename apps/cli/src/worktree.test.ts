import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWorktree,
  copyIncludedFiles,
  currentBranch,
  gitCommonDir,
  listWorktrees,
  mainCheckoutRoot,
  parseWorktreeList,
  pruneWorktrees,
  removeWorktree,
  repoRoot,
  runGit,
  sandboxGitAllowWrite,
  sanitizeWorktreeName,
  worktreeBinding,
  worktreeBranchName,
  worktreeChangeCount,
  worktreePathFor,
} from "./worktree.js";

describe("parseWorktreeList", () => {
  it("parses a main checkout plus a linked worktree", () => {
    const text = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.nova/worktrees/feat",
      "HEAD def456",
      "branch refs/heads/worktree-feat",
      "locked some reason",
      "",
      "worktree /repo/detached",
      "HEAD 999999",
      "detached",
      "",
    ].join("\n");

    expect(parseWorktreeList(text)).toEqual([
      {
        path: "/repo",
        head: "abc123",
        branch: "main",
        detached: false,
        bare: false,
        locked: false,
      },
      {
        path: "/repo/.nova/worktrees/feat",
        head: "def456",
        branch: "worktree-feat",
        detached: false,
        bare: false,
        locked: true,
      },
      {
        path: "/repo/detached",
        head: "999999",
        branch: null,
        detached: true,
        bare: false,
        locked: false,
      },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("sanitizeWorktreeName", () => {
  it.each(["feat", "fix-auth", "a_b.c", "v2"])("accepts %s", (name) => {
    expect(sanitizeWorktreeName(name)).toBe(name);
  });

  it.each(["", " ", ".", "..", ".hidden", "a/b", "a b", "a$(b)", "-x", "x".repeat(65)])(
    "rejects %j",
    (name) => {
      expect(sanitizeWorktreeName(name)).toBeUndefined();
    },
  );
});

describe("sandboxGitAllowWrite", () => {
  it("adds the repository's SHARED git dir, where objects and indexes live", () => {
    // Comes from `git rev-parse --git-common-dir`, so it also covers
    // `git init --separate-git-dir` (not just `<main>/.git`).
    expect(sandboxGitAllowWrite({ gitDir: "/elsewhere/shared.git" })).toEqual([
      "/elsewhere/shared.git",
    ]);
  });

  it("adds nothing in a normal checkout — the workspace already contains its .git", () => {
    expect(sandboxGitAllowWrite(null)).toEqual([]);
  });
});

describe("path + branch naming", () => {
  it("creates the checkout under the configured directory", () => {
    expect(worktreePathFor("/repo", ".nova/worktrees", "feat")).toBe("/repo/.nova/worktrees/feat");
    expect(worktreeBranchName("feat")).toBe("worktree-feat");
  });
});

describe("git integration", () => {
  let repo: string;

  async function commit(file: string, body: string, message: string): Promise<void> {
    await writeFile(join(repo, file), body, "utf8");
    await runGit(repo, ["add", "."]);
    expect((await runGit(repo, ["commit", "-q", "-m", message])).code).toBe(0);
  }

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "nova-worktree-")));
    expect((await runGit(repo, ["init", "-q", "-b", "main"])).code).toBe(0);
    await runGit(repo, ["config", "user.email", "test@example.com"]);
    await runGit(repo, ["config", "user.name", "Test"]);
    await writeFile(join(repo, ".gitignore"), ".env\n", "utf8");
    await commit("README.md", "hello\n", "init");
  });

  afterEach(async () => {
    // Worktrees hold a pointer into the main repo, so remove them before the
    // repo itself: a plain rm of the parent leaves stale registrations behind.
    for (const entry of await listWorktrees(repo)) {
      if (entry.path !== repo) await runGit(repo, ["worktree", "remove", "--force", entry.path]);
    }
    await rm(repo, { recursive: true, force: true });
  });

  it("resolves the repository root, common dir and main checkout", async () => {
    expect(await repoRoot(repo)).toBe(repo);
    expect(await gitCommonDir(repo)).toBe(join(repo, ".git"));
    expect(await mainCheckoutRoot(repo)).toBe(repo);
    expect(await worktreeBinding(repo)).toBeUndefined();
    expect(await currentBranch(repo)).toBe("main");
  });

  it("creates a worktree on worktree-<name>, idempotently", async () => {
    const first = await addWorktree({
      repo,
      name: "feat",
      dir: ".nova/worktrees",
      baseRef: "head",
    });
    expect(first.created).toBe(true);
    expect(first.branch).toBe("worktree-feat");
    expect((await stat(first.path)).isDirectory()).toBe(true);

    const binding = await worktreeBinding(first.path);
    expect(binding?.main).toBe(repo);
    expect(binding?.branch).toBe("worktree-feat");
    // What the OS sandbox needs on its write allowlist.
    expect(binding?.gitDir).toBe(join(repo, ".git"));

    const again = await addWorktree({
      repo,
      name: "feat",
      dir: ".nova/worktrees",
      baseRef: "head",
    });
    expect(again.created).toBe(false);
    expect(again.path).toBe(first.path);
    expect(await listWorktrees(repo)).toHaveLength(2);
  }, 30_000);

  it("excludes the worktree directory from the main checkout's status", async () => {
    await addWorktree({ repo, name: "feat", dir: ".nova/worktrees", baseRef: "head" });
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.nova/worktrees/");
    expect(exclude).toContain("/.tasks/");

    // Idempotent: a second worktree must not append the patterns again.
    await addWorktree({ repo, name: "fix", dir: ".nova/worktrees", baseRef: "head" });
    const after = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(after.split("\n").filter((l) => l === "/.nova/worktrees/")).toHaveLength(1);

    const status = await runGit(repo, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  }, 30_000);

  it("copies gitignored files listed in .worktreeinclude, and nothing else", async () => {
    await writeFile(join(repo, ".worktreeinclude"), ".env\n**/*.local\n", "utf8");
    await writeFile(join(repo, ".gitignore"), ".env\n*.local\n", "utf8");
    await writeFile(join(repo, ".env"), "SECRET=1\n", "utf8");
    // Neither ignored nor listed: a stray working-tree file must not travel.
    await writeFile(join(repo, "notes.md"), "scratch\n", "utf8");
    await runGit(repo, ["add", ".gitignore"]);
    await runGit(repo, ["commit", "-q", "-m", "ignore rules"]);

    const wt = await addWorktree({
      repo,
      name: "feat",
      dir: ".nova/worktrees",
      baseRef: "head",
      includeFile: ".worktreeinclude",
    });
    expect(wt.copied).toBe(1);
    expect(wt.skipped).toBe(0);
    expect(await readFile(join(wt.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(
      await stat(join(wt.path, "notes.md")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    // The copy is ignored and `.worktreeinclude` itself was never committed, so
    // the checkout reads clean.
    expect(await worktreeChangeCount(wt.path)).toBe(0);
  });

  it("never overwrites a file the target's start commit tracks", async () => {
    // A file that used to be tracked, then was untracked and gitignored. The
    // source now ignores it, so it is a copy candidate — but the target starts
    // from a commit where it is still TRACKED, and copying would clobber it.
    await writeFile(join(repo, "config.local"), "DEFAULT=1\n", "utf8");
    await runGit(repo, ["add", "config.local"]);
    await runGit(repo, ["commit", "-q", "-m", "track config.local"]);
    const trackedCommit = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();

    await runGit(repo, ["rm", "--cached", "-q", "config.local"]);
    await writeFile(join(repo, ".gitignore"), ".env\n*.local\n", "utf8");
    await runGit(repo, ["add", ".gitignore"]);
    await runGit(repo, ["commit", "-q", "-m", "untrack config.local"]);

    await writeFile(join(repo, "config.local"), "LOCAL_SECRET=demo\n", "utf8");
    await writeFile(join(repo, ".worktreeinclude"), "*.local\n", "utf8");

    const wt = await addWorktree({
      repo,
      name: "old",
      dir: ".nova/worktrees",
      baseRef: "head",
      from: trackedCommit,
      includeFile: ".worktreeinclude",
    });

    expect(wt.copied).toBe(0);
    expect(wt.skipped).toBe(1);
    // The tracked default survived — no secret smuggled into the checkout.
    expect(await readFile(join(wt.path, "config.local"), "utf8")).toBe("DEFAULT=1\n");
    expect((await runGit(wt.path, ["status", "--porcelain"])).stdout.trim()).toBe("");
  });

  it("skips a candidate the target checkout does not ignore", async () => {
    const beforeLocalRules = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repo, ".gitignore"), ".env\n*.local\n", "utf8");
    await runGit(repo, ["add", ".gitignore"]);
    await runGit(repo, ["commit", "-q", "-m", "ignore local files"]);
    await writeFile(join(repo, "notes.local"), "scratch\n", "utf8");
    await writeFile(join(repo, ".worktreeinclude"), "*.local\n", "utf8");

    const wt = await addWorktree({
      repo,
      name: "stale-rules",
      dir: ".nova/worktrees",
      baseRef: "head",
      from: beforeLocalRules,
      includeFile: ".worktreeinclude",
    });

    // Copying it would leave an untracked file in the fresh checkout, one
    // `git add -A` away from being committed.
    expect(wt.copied).toBe(0);
    expect(wt.skipped).toBe(1);
    expect(
      await stat(join(wt.path, "notes.local")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("never overwrites an existing file in the checkout", async () => {
    await writeFile(join(repo, ".gitignore"), ".env\n*.local\n", "utf8");
    await runGit(repo, ["add", ".gitignore"]);
    await runGit(repo, ["commit", "-q", "-m", "ignore local files"]);
    await writeFile(join(repo, "notes.local"), "from-source\n", "utf8");
    await writeFile(join(repo, ".worktreeinclude"), "*.local\n", "utf8");

    const wt = await addWorktree({ repo, name: "feat", dir: ".nova/worktrees", baseRef: "head" });
    await writeFile(join(wt.path, "notes.local"), "in-checkout\n", "utf8");

    const res = await copyIncludedFiles({
      repo,
      worktree: wt.path,
      includeFile: ".worktreeinclude",
    });
    expect(res.copied).toBe(0);
    expect(res.skipped).toBe(1);
    expect(await readFile(join(wt.path, "notes.local"), "utf8")).toBe("in-checkout\n");
  });

  it("places a checkout under the MAIN root even when launched from a worktree", async () => {
    const first = await addWorktree({
      repo,
      name: "first",
      dir: ".nova/worktrees",
      baseRef: "head",
    });
    const second = await addWorktree({
      repo: first.path,
      name: "second",
      dir: ".nova/worktrees",
      baseRef: "head",
    });

    expect(second.path).toBe(join(repo, ".nova", "worktrees", "second"));
    // The old behavior nested it: <first>/.nova/worktrees/second.
    expect(
      await stat(join(first.path, ".nova")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("reuses an existing worktree by name when launched from inside it", async () => {
    const first = await addWorktree({
      repo,
      name: "first",
      dir: ".nova/worktrees",
      baseRef: "head",
    });
    const again = await addWorktree({
      repo: first.path,
      name: "first",
      dir: ".nova/worktrees",
      baseRef: "head",
    });
    expect(again.created).toBe(false);
    expect(again.path).toBe(first.path);
  }, 30_000);

  it("starts from the LAUNCH checkout's HEAD, not the main checkout's", async () => {
    const first = await addWorktree({
      repo,
      name: "first",
      dir: ".nova/worktrees",
      baseRef: "head",
    });
    await writeFile(join(first.path, "b.txt"), "b\n", "utf8");
    await runGit(first.path, ["add", "."]);
    expect((await runGit(first.path, ["commit", "-q", "-m", "work in first"])).code).toBe(0);

    const firstHead = (await runGit(first.path, ["rev-parse", "HEAD"])).stdout.trim();
    const mainHead = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    expect(firstHead).not.toBe(mainHead);

    const second = await addWorktree({
      repo: first.path,
      name: "second",
      dir: ".nova/worktrees",
      baseRef: "head",
    });
    expect((await runGit(second.path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(firstHead);
  });

  it("fresh prefers a resolvable origin/HEAD over the launch checkout's HEAD", async () => {
    const mainHead = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const first = await addWorktree({
      repo,
      name: "first",
      dir: ".nova/worktrees",
      baseRef: "head",
    });
    await writeFile(join(first.path, "b.txt"), "b\n", "utf8");
    await runGit(first.path, ["add", "."]);
    await runGit(first.path, ["commit", "-q", "-m", "work in first"]);
    const firstHead = (await runGit(first.path, ["rev-parse", "HEAD"])).stdout.trim();
    expect(firstHead).not.toBe(mainHead);

    // A cached origin/HEAD is the "fresh" base; no fetch happens during creation.
    await runGit(repo, ["update-ref", "refs/remotes/origin/HEAD", mainHead]);

    const fresh = await addWorktree({
      repo: first.path,
      name: "fresh",
      dir: ".nova/worktrees",
      baseRef: "fresh",
    });
    expect((await runGit(fresh.path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(mainHead);
  });

  it("handles a repository whose git dir lives outside the working tree", async () => {
    // `git init --separate-git-dir`: `dirname(gitCommonDir)` is a metadata
    // directory, not a checkout — and git itself lists the git dir as the
    // "main worktree", so neither shortcut can find the real working tree.
    const base = await realpath(await mkdtemp(join(tmpdir(), "nova-separate-")));
    const work = join(base, "work");
    const meta = join(base, "metadata", "gitdir");
    try {
      await mkdir(work, { recursive: true });
      await mkdir(join(base, "metadata"), { recursive: true });
      expect(
        (await runGit(work, ["init", "-q", "--separate-git-dir", meta, "-b", "main", "."])).code,
      ).toBe(0);
      await runGit(work, ["config", "user.email", "test@example.com"]);
      await runGit(work, ["config", "user.name", "Test"]);
      await writeFile(join(work, "a.txt"), "a\n");
      await runGit(work, ["add", "."]);
      await runGit(work, ["commit", "-q", "-m", "init"]);

      // The ordinary checkout must not be mistaken for a linked worktree.
      expect(await mainCheckoutRoot(work)).toBe(work);
      expect(await worktreeBinding(work)).toBeUndefined();

      const wt = await addWorktree({
        repo: work,
        name: "feat",
        dir: ".nova/worktrees",
        baseRef: "head",
      });
      expect(wt.path).toBe(join(work, ".nova", "worktrees", "feat"));
      // What the sandbox has to be allowed to write, wherever it lives.
      expect(await gitCommonDir(wt.path)).toBe(meta);

      // The linked worktree still gets a binding (the classification proves it
      // IS a worktree) — just without a nameable main checkout. That is what
      // keeps the isolation guard alive in this layout.
      const binding = await worktreeBinding(wt.path);
      expect(binding?.path).toBe(wt.path);
      expect(binding?.main).toBeUndefined();
      expect(binding?.gitDir).toBe(meta);

      // From inside that worktree the main checkout is not derivable — refuse
      // rather than running git in the metadata directory.
      await expect(
        addWorktree({ repo: wt.path, name: "second", dir: ".nova/worktrees", baseRef: "head" }),
      ).rejects.toThrow(/cannot locate the main checkout/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("counts changes and distinguishes an unreadable checkout from a clean one", async () => {
    const wt = await addWorktree({ repo, name: "feat", dir: ".nova/worktrees", baseRef: "head" });
    expect(await worktreeChangeCount(wt.path)).toBe(0);
    await writeFile(join(wt.path, "new.txt"), "x", "utf8");
    expect(await worktreeChangeCount(wt.path)).toBe(1);

    // "Could not determine" must never masquerade as "clean" (0): a caller that
    // deletes the checkout would otherwise think there is nothing to lose.
    expect(await worktreeChangeCount(join(repo, "does-not-exist"))).toBe(-1);
  });

  it("counts a copy that fails instead of reporting it as copied", async () => {
    // The target branch tracks a FILE named `secrets`, so the directory the
    // include file needs cannot be created there.
    await writeFile(join(repo, "secrets"), "i am a tracked file\n", "utf8");
    await runGit(repo, ["add", "secrets"]);
    await runGit(repo, ["commit", "-q", "-m", "track a file named secrets"]);
    await writeFile(join(repo, ".gitignore"), ".env\nsecrets/\n", "utf8");
    await runGit(repo, ["add", ".gitignore"]);
    await runGit(repo, ["commit", "-q", "-m", "ignore secrets/"]);
    const targetCommit = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();

    // In the source the same path is a directory holding an ignored file.
    await rm(join(repo, "secrets"));
    await mkdir(join(repo, "secrets"));
    await writeFile(join(repo, "secrets", "app.json"), '{"token":"x"}\n', "utf8");
    await writeFile(join(repo, ".worktreeinclude"), "secrets/*.json\n", "utf8");

    const wt = await addWorktree({
      repo,
      name: "blocked",
      dir: ".nova/worktrees",
      baseRef: "head",
      from: targetCommit,
      includeFile: ".worktreeinclude",
    });

    expect(wt.copied).toBe(0);
    expect(wt.failed).toBe(1);
    // The tracked file the copy would have collided with is untouched.
    expect(await readFile(join(wt.path, "secrets"), "utf8")).toBe("i am a tracked file\n");
  });

  it("rejects a name that already exists as an unrelated directory", async () => {
    await mkdir(join(repo, ".nova", "worktrees", "taken"), { recursive: true });
    await expect(
      addWorktree({ repo, name: "taken", dir: ".nova/worktrees", baseRef: "head" }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects an invalid start point without leaving anything behind", async () => {
    await expect(
      addWorktree({
        repo,
        name: "bad",
        dir: ".nova/worktrees",
        baseRef: "head",
        from: "no-such-ref",
      }),
    ).rejects.toThrow(/not a commit/);
    expect(
      await stat(join(repo, ".nova")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);

    // An option-looking ref is never handed to git as a flag.
    await expect(
      addWorktree({ repo, name: "bad", dir: ".nova/worktrees", baseRef: "head", from: "--force" }),
    ).rejects.toThrow(/looks like an option/);
  });

  it("rejects an invalid name", async () => {
    await expect(
      addWorktree({ repo, name: "../escape", dir: ".nova/worktrees", baseRef: "head" }),
    ).rejects.toThrow(/invalid worktree name/);
  });

  it("rejects a non-repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "nova-plain-"));
    try {
      await expect(
        addWorktree({ repo: plain, name: "x", dir: ".nova/worktrees", baseRef: "head" }),
      ).rejects.toThrow(/not a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("removes a worktree and prunes the registration", async () => {
    const wt = await addWorktree({ repo, name: "feat", dir: ".nova/worktrees", baseRef: "head" });
    await removeWorktree({ repo, path: wt.path });
    expect(
      await stat(wt.path).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await listWorktrees(repo)).toHaveLength(1);
    expect((await pruneWorktrees(repo)).length).toBeGreaterThanOrEqual(0);
  });
});
