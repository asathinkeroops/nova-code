import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionWorkspace,
  readSessionWorktreeMain,
  settingsSchema,
  type Settings,
} from "@nova/base";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "./context.js";
import { HeadlessScreen } from "./headless-screen.js";
import type { CliContext } from "./ctx-types.js";
import { addWorktree, runGit } from "./worktree.js";
import { resolveSession } from "./session.js";
import { handleWorktree } from "./commands/worktree.js";
import { handleClear } from "./commands/clear.js";

/**
 * Startup wiring smoke test.
 *
 * `createContext` is ~1200 lines of assembly that no unit test touches: it
 * builds the permission engine, tool registry, agent, slash registries, skill
 * index, hooks and session state, then hands back a live context. A single
 * mistake in that wiring — a missing import, a bad call order, an unawaited
 * promise — takes the CLI down at launch while every unit test stays green.
 * That has happened (see `fix(cli): import pluginSkillRoots into context.ts`).
 *
 * So this asserts the one thing unit tests structurally cannot: that startup
 * runs to completion and produces a context with its parts attached. It is
 * deliberately shallow on behaviour — the individual pieces have their own
 * tests — and its value is entirely in *executing* the assembly path.
 *
 * Everything that would reach the network or the developer's real `~/.nova` is
 * switched off below; the provider key is a placeholder because the model
 * client is constructed but never called.
 */
function isolatedSettings(sessionDir: string): Settings {
  return settingsSchema.parse({
    providers: [
      {
        name: "generic",
        profile: "generic",
        apiKey: "test-key-not-used",
        models: {
          lite: { id: "test-lite" },
          pro: { id: "test-pro" },
          max: { id: "test-max" },
        },
      },
    ],
    sessionDir,
    // No outbound connections from a test run.
    mcp: { enabled: false },
    // `guide.source: "remote"` kicks off a background `git clone` of the nova
    // repo at startup; "local" resolves to the workspace and clones nothing.
    guide: { enabled: false, source: "local" },
    // Auto-memory writes under ~/.nova by design; keep the test off the real
    // store (see the auto-memory-is-personal note in the memory docs).
    memory: { auto: { enabled: false } },
    // Same reason: the default scan walks the real `~/.nova/skills`, so an
    // installed skill would leak into the block this file asserts is empty.
    skills: { userPaths: [] },
    lsp: { enabled: false },
    sandbox: { enabled: false },
    plugins: { enabled: false },
    logging: { pretty: false },
  });
}

const built: CliContext[] = [];

async function startup(workspaceOverride?: string): Promise<CliContext> {
  const workspace = workspaceOverride ?? mkdtempSync(join(tmpdir(), "nova-smoke-ws-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "nova-smoke-sessions-"));
  const ctx = await createContext(isolatedSettings(sessionDir), new HeadlessScreen(), {
    cwd: workspace,
    noTranscript: true,
    noPretty: true,
  });
  built.push(ctx);
  return ctx;
}

afterEach(async () => {
  // Mirrors the REPL's own shutdown sequence (`shutdown` in repl.ts). Startup
  // arms a cron scheduler and holds a sandbox handle; leaving them live keeps
  // vitest's process alive after the suite finishes.
  for (const ctx of built.splice(0)) {
    ctx.cronScheduler.dispose();
    await ctx.backgroundManager.disposeAll();
    await ctx.monitorManager.disposeAll();
    if (ctx.lspManager) await ctx.lspManager.disposeAll();
    await ctx.sandbox.dispose();
    if (ctx.mcp) await ctx.mcp.close();
  }
});

/**
 * A throwaway repository with one commit, so worktree operations (which need a
 * real object database) can run without touching the developer's checkout.
 */
async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "nova-smoke-repo-"));
  await runGit(repo, ["init", "-q", "-b", "main"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  await runGit(repo, ["add", "."]);
  await runGit(repo, ["commit", "-q", "-m", "init"]);
  // macOS: /var is a symlink to /private/var, and git reports canonical paths.
  return realpathSync(repo);
}

describe("createContext — startup wiring", () => {
  it("completes without throwing and returns a wired context", async () => {
    const ctx = await startup();
    expect(ctx.workspace).toBeTruthy();
    expect(ctx.session.id).toBeTruthy();
    expect(ctx.agent).toBeTruthy();
    expect(ctx.permission).toBeTruthy();
    expect(ctx.registry).toBeTruthy();
    expect(ctx.checkPermission).toBeTypeOf("function");
    expect(ctx.dispatch).toBeTypeOf("function");
  });

  it("registers the built-in tools and slash commands", async () => {
    const ctx = await startup();
    const toolNames = ctx.tools.definitions().map((d) => d.name);
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("edit");
    expect(ctx.registry.list().length).toBeGreaterThan(0);
  });

  it("builds a skills block without a skill directory present", async () => {
    // The empty-workspace path: no SKILL.md anywhere, so the block collapses to
    // "" and the system prompt drops the section entirely.
    const ctx = await startup();
    expect(ctx.skillsBlock).toBe("");
  });
});

describe("createContext — workspace switch (/worktree)", () => {
  it("moves the session into a worktree and fences the main checkout", async () => {
    const repo = await makeRepo();
    try {
      const ctx = await startup(repo);
      const created = await addWorktree({
        repo,
        name: "feat",
        dir: ".nova/worktrees",
        baseRef: "head",
      });

      const binding = await ctx.setWorkspace(created.path);
      expect(ctx.workspace).toBe(created.path);
      expect(binding?.main).toBe(repo);
      // The session is re-bound, so a later `--resume` returns here.
      expect(await readSessionWorkspace(ctx.session)).toBe(created.path);

      // Isolation: the main checkout is out of bounds, the worktree is not.
      const outside = await ctx.checkPermission("edit", { path: join(repo, "README.md") });
      expect(outside.granted).toBe(false);
      expect(outside.reason).toMatch(/main checkout/);

      const inside = await ctx.checkPermission("edit", {
        path: join(created.path, "README.md"),
      });
      expect(inside.reason ?? "").not.toMatch(/main checkout/);
      expect(ctx.worktree?.path).toBe(created.path);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses to switch to a directory outside the repository", async () => {
    const repo = await makeRepo();
    try {
      const ctx = await startup(repo);
      const outside = mkdtempSync(join(tmpdir(), "nova-smoke-outside-"));
      await expect(ctx.setWorkspace(outside)).rejects.toThrow(/refusing to switch/);
      expect(ctx.workspace).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("createContext — pre-resolved session target", () => {
  it("uses the host's resolved session/workspace instead of resolving again", async () => {
    const repo = await makeRepo();
    try {
      const wt = await addWorktree({ repo, name: "feat", dir: ".nova/worktrees", baseRef: "head" });
      const sessionDir = mkdtempSync(join(tmpdir(), "nova-smoke-target-sessions-"));
      // The host resolves (and trust-checks) this BEFORE createContext.
      const target = await resolveSession({}, sessionDir, wt.path);

      const ctx = await createContext(
        isolatedSettings(sessionDir),
        new HeadlessScreen(),
        { cwd: target.workspace, noTranscript: true, noPretty: true },
        target,
      );
      built.push(ctx);

      expect(ctx.session.id).toBe(target.session.id);
      expect(ctx.workspace).toBe(wt.path);
      expect(ctx.worktree?.main).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("createContext — file tools touch the path the gate approved (WT17)", () => {
  it("writes the approved workspace file when `..` follows a symlink", async () => {
    const repo = await makeRepo();
    try {
      const wt = await addWorktree({ repo, name: "feat", dir: ".nova/worktrees", baseRef: "head" });
      mkdirSync(join(wt.path, "sub"), { recursive: true });
      writeFileSync(join(repo, "victim.txt"), "MAIN\n");
      writeFileSync(join(wt.path, "victim.txt"), "WORKTREE\n");
      // A link in the MAIN checkout pointing into the worktree: the literal path
      // walks out through `..` into the main checkout, while the real target is
      // the worktree file the gate approved.
      symlinkSync(join(wt.path, "sub"), join(repo, "worktree-link"));

      const ctx = await startup(wt.path);
      const raw = `${repo}/worktree-link/../victim.txt`;

      const permission = await ctx.checkPermission("write", {
        path: raw,
        content: "OVERWRITTEN\n",
      });
      expect(permission.granted).toBe(true);

      const result = await ctx.dispatch(
        {
          type: "tool_use",
          id: "wt17-write",
          name: "write",
          input: { path: raw, content: "OVERWRITTEN\n" },
        },
        { cwd: ctx.workspace },
      );
      const block = "result" in result ? result.result : result;
      expect(block.is_error ?? false).toBe(false);
      // Execution and the checks named the same file — the worktree one.
      expect(readFileSync(join(wt.path, "victim.txt"), "utf8")).toBe("OVERWRITTEN\n");
      expect(readFileSync(join(repo, "victim.txt"), "utf8")).toBe("MAIN\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("createContext — worktree command handlers", () => {
  it("/worktree new builds from the CURRENT checkout (WT09)", async () => {
    const repo = await makeRepo();
    try {
      const first = await addWorktree({
        repo,
        name: "first",
        dir: ".nova/worktrees",
        baseRef: "head",
      });
      // A commit that only exists in `first`, so main and first diverge.
      writeFileSync(join(first.path, "only-first.txt"), "x\n");
      await runGit(first.path, ["add", "."]);
      await runGit(first.path, ["commit", "-q", "-m", "work in first"]);
      const firstHead = (await runGit(first.path, ["rev-parse", "HEAD"])).stdout.trim();
      const mainHead = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
      expect(firstHead).not.toBe(mainHead);

      // Local state that differs per checkout, listed for copying.
      writeFileSync(join(repo, ".env"), "SOURCE=main\n");
      writeFileSync(join(first.path, ".env"), "SOURCE=first\n");
      writeFileSync(join(first.path, ".worktreeinclude"), ".env\n");

      const ctx = await startup(first.path);
      await handleWorktree(ctx, "new second from HEAD");

      const second = join(repo, ".nova", "worktrees", "second");
      expect(ctx.workspace).toBe(second);
      // HEAD came from `first`, not from the main checkout.
      expect((await runGit(second, ["rev-parse", "HEAD"])).stdout.trim()).toBe(firstHead);
      // …and so did the included file.
      expect(readFileSync(join(second, ".env"), "utf8")).toBe("SOURCE=first\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("/clear keeps the worktree binding on the new session (WT11)", async () => {
    const repo = await makeRepo();
    try {
      const wt = await addWorktree({ repo, name: "feat", dir: ".nova/worktrees", baseRef: "head" });
      const ctx = await startup(wt.path);
      // `/clear` reuses an empty session; give it history so it creates one.
      ctx.screen.setMessages([{ role: "user", content: "hello" }]);
      const before = ctx.session.id;

      await handleClear(ctx);

      expect(ctx.session.id).not.toBe(before);
      expect(await readSessionWorkspace(ctx.session)).toBe(wt.path);
      // Without this, resuming after the checkout is deleted reports a workspace
      // mismatch instead of falling back to the launch directory.
      expect(await readSessionWorktreeMain(ctx.session)).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("createContext — separate git dir layout", () => {
  it("keeps isolation alive without a nameable main checkout", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nova-smoke-sep-")));
    const work = join(base, "work");
    const meta = join(base, "metadata", "gitdir");
    try {
      mkdirSync(work, { recursive: true });
      mkdirSync(join(base, "metadata"), { recursive: true });
      await runGit(work, ["init", "-q", "--separate-git-dir", meta, "-b", "main", "."]);
      await runGit(work, ["config", "user.email", "test@example.com"]);
      await runGit(work, ["config", "user.name", "Test"]);
      writeFileSync(join(work, "README.md"), "hi\n");
      await runGit(work, ["add", "."]);
      await runGit(work, ["commit", "-q", "-m", "init"]);

      const wt = join(base, "wt");
      await runGit(work, ["worktree", "add", "-q", wt, "-b", "feat"]);

      const ctx = await startup(wt);
      // A binding exists (the checkout IS a linked worktree) even though the
      // main working tree cannot be named.
      expect(ctx.worktree).not.toBeNull();
      expect(ctx.worktree?.main).toBeUndefined();
      expect(ctx.worktree?.gitDir).toBe(meta);

      // …and the guard still finds the main working tree by classification.
      const outside = await ctx.checkPermission("edit", { path: join(work, "README.md") });
      expect(outside.granted).toBe(false);
      expect(outside.reason).toMatch(/another checkout of this repository/);

      const redirected = await ctx.checkPermission("bash", { command: `git -C ${work} status` });
      expect(redirected.granted).toBe(false);

      const inside = await ctx.checkPermission("edit", { path: join(wt, "README.md") });
      expect(inside.reason ?? "").not.toMatch(/checkout of this repository/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it("creates AND enters a worktree from the main checkout (WT15)", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nova-smoke-sep-new-")));
    const work = join(base, "work");
    const meta = join(base, "metadata", "gitdir");
    try {
      mkdirSync(work, { recursive: true });
      mkdirSync(join(base, "metadata"), { recursive: true });
      await runGit(work, ["init", "-q", "--separate-git-dir", meta, "-b", "main", "."]);
      await runGit(work, ["config", "user.email", "test@example.com"]);
      await runGit(work, ["config", "user.name", "Test"]);
      writeFileSync(join(work, "README.md"), "hi\n");
      await runGit(work, ["add", "."]);
      await runGit(work, ["commit", "-q", "-m", "init"]);

      // The session starts IN the main checkout, whose git dir lives outside it.
      const ctx = await startup(work);
      expect(ctx.worktree).toBeNull();

      await handleWorktree(ctx, "new feat");

      const target = join(work, ".nova", "worktrees", "feat");
      expect(ctx.workspace).toBe(target);
      // Repository identity is the shared git dir; the main checkout itself
      // still cannot be named in this layout.
      expect(ctx.worktree?.gitDir).toBe(meta);
      expect(ctx.worktree?.main).toBeUndefined();
      expect(await readSessionWorkspace(ctx.session)).toBe(target);

      // Moving BACK to the main checkout is the same repository, so it is allowed.
      await ctx.setWorkspace(work);
      expect(ctx.workspace).toBe(work);
      expect(ctx.worktree).toBeNull();

      // A sibling checkout of the same repository is reachable…
      const sibling = join(base, "sibling");
      await runGit(work, ["worktree", "add", "-q", sibling, "-b", "sibling"]);
      const binding = await ctx.setWorkspace(sibling);
      expect(ctx.workspace).toBe(sibling);
      expect(binding?.gitDir).toBe(meta);

      // …while another repository is still refused.
      const other = realpathSync(mkdtempSync(join(tmpdir(), "nova-smoke-sep-other-")));
      try {
        await runGit(other, ["init", "-q", "-b", "main"]);
        await expect(ctx.setWorkspace(other)).rejects.toThrow(/refusing to switch/);
        expect(ctx.workspace).toBe(sibling);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});
