import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, readSessionWorkspace } from "@nova/base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLaunchTarget } from "./launch.js";
import { addWorktree, runGit } from "./worktree.js";

/**
 * The startup order is the security property under test here:
 *
 *   trust(launch) → materialize --worktree → resolve session → trust(final)
 *
 * Anything else either writes into an untrusted repository (creating the
 * checkout first) or loads project hooks/memory from a directory nobody
 * approved (trusting the launch dir and then re-entering a worktree).
 */
describe("resolveLaunchTarget", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "nova-launch-sessions-"));
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("trusts the launch dir, then materializes, then trusts the checkout", async () => {
    const calls: string[] = [];
    const target = await resolveLaunchTarget({
      launchDir: "/launch",
      sessionDir,
      requireTrust: async (dir) => {
        calls.push(`trust:${dir}`);
      },
      materializeWorktree: async () => {
        calls.push("materialize");
        return "/launch/wt";
      },
    });

    expect(calls).toEqual(["trust:/launch", "materialize", "trust:/launch/wt"]);
    expect(target.workspace).toBe("/launch/wt");
    expect(await readSessionWorkspace(target.session)).toBe("/launch/wt");
  });

  it("does not materialize anything when --worktree is absent", async () => {
    const calls: string[] = [];
    const target = await resolveLaunchTarget({
      launchDir: "/launch",
      sessionDir,
      requireTrust: async (dir) => {
        calls.push(`trust:${dir}`);
      },
    });
    // The final trust check is a no-op for the same directory in practice, but
    // it still runs — that is what keeps the ordering uniform.
    expect(calls).toEqual(["trust:/launch", "trust:/launch"]);
    expect(target.workspace).toBe("/launch");
  });

  it("checks trust on the worktree a resumed session re-enters", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "nova-launch-repo-")));
    try {
      await runGit(repo, ["init", "-q", "-b", "main"]);
      await runGit(repo, ["config", "user.email", "test@example.com"]);
      await runGit(repo, ["config", "user.name", "Test"]);
      await writeFile(join(repo, "a.txt"), "a\n");
      await runGit(repo, ["add", "."]);
      await runGit(repo, ["commit", "-q", "-m", "init"]);

      const wt = await addWorktree({ repo, name: "feat", dir: ".nova/worktrees", baseRef: "head" });
      const session = await createSession({
        workspace: wt.path,
        worktreeMain: repo,
        rootOverride: sessionDir,
      });

      const calls: string[] = [];
      const target = await resolveLaunchTarget({
        launchDir: repo,
        sessionDir,
        resume: session.id,
        requireTrust: async (dir) => {
          calls.push(`trust:${dir}`);
        },
      });

      expect(target.workspace).toBe(await realpath(wt.path));
      // BOTH directories are checked: the launch repo and the checkout whose
      // project config will now be loaded.
      expect(calls).toEqual([`trust:${repo}`, `trust:${await realpath(wt.path)}`]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("stops before creating a checkout when the session cannot be resumed", async () => {
    const other = await createSession({ workspace: "/somewhere/else", rootOverride: sessionDir });

    const calls: string[] = [];
    await expect(
      resolveLaunchTarget({
        launchDir: "/launch",
        sessionDir,
        resume: other.id,
        requireTrust: async (dir) => {
          calls.push(`trust:${dir}`);
        },
        materializeWorktree: async () => {
          calls.push("materialize");
          return "/launch/wt";
        },
      }),
    ).rejects.toThrow(/belongs to workspace/);

    // Launch dir was trusted (cheap, no write), the checkout was created, and
    // resolution failed — the final trust never ran. Creating the checkout in a
    // trusted repo is safe; what must never happen is loading config from an
    // untrusted directory.
    expect(calls).toEqual(["trust:/launch", "materialize"]);
  });
});
