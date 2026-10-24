import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planWorktreeLaunch, worktreeFlagConflict } from "./worktree-launch.js";
import { runGit } from "./worktree.js";

describe("worktreeFlagConflict", () => {
  it("rejects --worktree together with --resume", () => {
    const reason = worktreeFlagConflict({ worktree: "feat", resume: "20260101-abcd1234" });
    expect(reason).toContain("cannot be combined with --resume");
    // Names both ways out, so the message is actionable.
    expect(reason).toContain("nova --resume <id>");
    expect(reason).toContain("drop --resume");
  });

  it("allows --continue: it means 'the last session in this workspace'", () => {
    expect(worktreeFlagConflict({ worktree: "feat", continue: true })).toBeUndefined();
  });

  it("only fires when BOTH flags are present", () => {
    expect(worktreeFlagConflict({ worktree: "feat" })).toBeUndefined();
    expect(worktreeFlagConflict({ resume: "id" })).toBeUndefined();
    expect(worktreeFlagConflict({ worktree: true })).toBeUndefined();
  });
});

describe("planWorktreeLaunch", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "nova-wt-plan-")));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await runGit(repo, ["config", "user.email", "test@example.com"]);
    await runGit(repo, ["config", "user.name", "Test"]);
    await writeFile(join(repo, "a.txt"), "a\n");
    await runGit(repo, ["add", "."]);
    await runGit(repo, ["commit", "-q", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("fails on the conflicting flags before creating any checkout", async () => {
    await expect(
      planWorktreeLaunch({ worktree: "feat", resume: "20260101-abcd1234", cwd: repo }),
    ).rejects.toThrow(/cannot be combined with --resume/);

    // The whole point: no orphan checkout on disk, and no worktree registered.
    expect(existsSync(join(repo, ".nova", "worktrees", "feat"))).toBe(false);
    const list = await runGit(repo, ["worktree", "list", "--porcelain"]);
    expect(list.stdout).not.toContain("feat");
  });
});
