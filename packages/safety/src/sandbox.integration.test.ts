import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { describe, expect, it } from "vitest";
import { createSandbox, type SandboxControl } from "./sandbox.js";

/**
 * Real-sandbox integration check for the git-worktree case.
 *
 * A linked worktree keeps everything mutable in the MAIN checkout's `.git`
 * (objects, refs, and this checkout's own `worktrees/<name>/index`), which sits
 * OUTSIDE the worktree path. Unless the CLI puts that directory on the sandbox
 * write allowlist, `git add` / `git commit` die with EPERM on `index.lock` —
 * a failure that only shows up on a real OS sandbox, never in the mocked unit
 * tests. This asserts both halves of that contract:
 *
 *   - no `.git` entry  → the commit is denied;
 *   - with `.git`      → the commit succeeds.
 *
 * It runs only where a sandbox can actually initialize (macOS sandbox-exec,
 * Linux bubblewrap + user namespaces). Elsewhere it degrades to a skip so CI
 * without the host dependencies stays green.
 */

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const canRun =
  hasGit() &&
  SandboxManager.isSupportedPlatform() &&
  SandboxManager.checkDependencies().errors.length === 0;

function run(cwd: string, command: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/bash", ["-c", command], { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

interface ScenarioResult {
  /** True when the sandbox could not initialize here (unsupported / deps / nested). */
  skipped: boolean;
  code: number;
  commits: number;
  output: string;
}

async function commitInsideSandbox(opts: {
  worktree: string;
  mainGitDir: string | undefined;
  label: string;
}): Promise<ScenarioResult> {
  let control: SandboxControl | undefined;
  try {
    control = await createSandbox({
      enabled: true,
      writeRoots: [opts.worktree],
      ...(opts.mainGitDir ? { extraAllowWrite: [opts.mainGitDir] } : {}),
      allowGitConfig: true,
      monitorViolations: false,
    });
    if (!control.active || !control.bridge) {
      return { skipped: true, code: 0, commits: 0, output: control.reason ?? "" };
    }
    const command = `git add -A && git commit -q -m 'sandbox-${opts.label}'`;
    const wrapped = await control.bridge.wrapCommand(command);
    const result = await run(opts.worktree, wrapped);
    control.bridge.afterCommand();
    const commits = Number((await git(opts.worktree, ["rev-list", "--count", "HEAD"])).trim());
    return { skipped: false, code: result.code, commits, output: result.output };
  } finally {
    await control?.dispose();
  }
}

describe.skipIf(!canRun)("createSandbox — git inside a linked worktree", () => {
  it("commits only when the main checkout's .git is on the write allowlist", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "nova-safety-wt-")));
    try {
      await git(base, ["init", "-q", "-b", "main"]);
      await git(base, ["config", "user.email", "test@example.com"]);
      await git(base, ["config", "user.name", "Test"]);
      await writeFile(join(base, "a.txt"), "a\n");
      await git(base, ["add", "."]);
      await git(base, ["commit", "-q", "-m", "init"]);

      const worktree = join(base, ".nova", "worktrees", "feat");
      await git(base, ["worktree", "add", "-b", "worktree-feat", worktree]);
      await writeFile(join(worktree, "a.txt"), "b\n");

      const without = await commitInsideSandbox({
        worktree,
        mainGitDir: undefined,
        label: "without",
      });
      if (without.skipped) {
        // No real sandbox on this host (unsupported platform / missing deps /
        // nested sandbox). Nothing to assert — see the describe guard.
        expect(without.output.length).toBeGreaterThan(0);
        return;
      }
      expect(without.code).not.toBe(0);
      expect(without.commits).toBe(1);
      expect(without.output).toMatch(/index\.lock|Operation not permitted/);

      const withGit = await commitInsideSandbox({
        worktree,
        mainGitDir: join(base, ".git"),
        label: "with",
      });
      expect(withGit.code).toBe(0);
      expect(withGit.commits).toBe(2);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 30_000);
});
