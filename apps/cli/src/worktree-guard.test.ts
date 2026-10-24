import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { worktreeIsolationDenial } from "./worktree-guard.js";
import { runGit } from "./worktree.js";

const MAIN = "/repo";
const WORKSPACE = "/repo/.nova/worktrees/feat";

function check(tool: string, input: Record<string, unknown>, path?: string): string | undefined {
  return worktreeIsolationDenial({
    main: MAIN,
    workspace: WORKSPACE,
    tool,
    input,
    ...(path ? { path } : {}),
  })?.reason;
}

/** A layout where the command runs NEXT TO the main checkout, not inside it. */
const PARENT = "/parent";
const PARENT_MAIN = "/parent/repo";
const PARENT_WORKSPACE = "/parent/repo/.nova/worktrees/first";

function checkFromParent(tool: string, input: Record<string, unknown>): string | undefined {
  return worktreeIsolationDenial({
    main: PARENT_MAIN,
    workspace: PARENT_WORKSPACE,
    checkouts: [PARENT_WORKSPACE],
    tool,
    input,
  })?.reason;
}

describe("worktree isolation — file tools", () => {
  it("refuses a write into the main checkout", () => {
    expect(check("write", { path: "x" }, `${MAIN}/src/app.ts`)).toBeDefined();
  });

  it("refuses an edit of a file only reachable through the main checkout", () => {
    expect(check("edit", { path: "x" }, `${MAIN}/README.md`)).toBeDefined();
  });

  it("allows writes inside the worktree", () => {
    expect(check("write", { path: "x" }, `${WORKSPACE}/src/app.ts`)).toBeUndefined();
  });

  it("leaves read alone — reading the main checkout is legitimate", () => {
    expect(check("read", { path: "x" }, `${MAIN}/README.md`)).toBeUndefined();
    expect(check("grep", { path: "x" }, `${MAIN}/src`)).toBeUndefined();
  });
});

describe("worktree isolation — command tools", () => {
  it("refuses an explicit cwd in the main checkout", () => {
    expect(check("bash", { command: "ls", cwd: MAIN })).toBeDefined();
    expect(check("bash", { command: "ls", cwd: `${MAIN}/src` })).toBeDefined();
    expect(check("monitor", { command: "tail -f x", cwd: MAIN })).toBeDefined();
  });

  it("allows an explicit cwd inside the worktree", () => {
    expect(check("bash", { command: "ls", cwd: WORKSPACE })).toBeUndefined();
    expect(check("bash", { command: "ls", cwd: "src" })).toBeUndefined();
  });

  it("refuses a cd into the main checkout (relative or absolute)", () => {
    expect(check("bash", { command: "cd ../.. && git status" })).toBeDefined();
    expect(check("bash", { command: `cd ${MAIN} && npm test` })).toBeDefined();
    expect(check("bash", { command: 'cd "/repo" ; ls' })).toBeDefined();
  });

  it("allows a cd that stays inside the worktree", () => {
    expect(check("bash", { command: "cd src && ls" })).toBeUndefined();
    expect(check("bash", { command: "cd .nova && ls" })).toBeUndefined();
  });

  it("refuses a cd after a newline (multi-line scripts are not a blind spot)", () => {
    expect(check("bash", { command: "echo ready\ncd /repo && pwd" })).toBeDefined();
    expect(check("bash", { command: "echo ready\n  cd /repo && pwd" })).toBeDefined();
    expect(check("bash", { command: "echo a\n\ncd /repo" })).toBeDefined();
  });

  it("refuses a cd inside a subshell or a brace group", () => {
    expect(check("bash", { command: "(cd /repo && git status)" })).toBeDefined();
    expect(check("bash", { command: "{ cd /repo; git status; }" })).toBeDefined();
  });

  it("handles quoted paths across separators", () => {
    expect(check("bash", { command: 'echo x\ncd "/repo" && pwd' })).toBeDefined();
    expect(check("bash", { command: "echo x\ncd '/repo' && pwd" })).toBeDefined();
  });

  it("allows multi-line scripts that stay inside the worktree", () => {
    expect(check("bash", { command: "cd src\npnpm test\n" })).toBeUndefined();
    expect(check("bash", { command: "echo ready\nls -la\n" })).toBeUndefined();
  });

  it("refuses git redirected at the main checkout", () => {
    expect(check("bash", { command: `git -C ${MAIN} status` })).toBeDefined();
    expect(check("bash", { command: `git --git-dir=${MAIN}/.git status` })).toBeDefined();
    expect(check("bash", { command: `GIT_DIR=${MAIN}/.git git log` })).toBeDefined();
    expect(check("bash", { command: `GIT_WORK_TREE=${MAIN} git checkout .` })).toBeDefined();
  });

  it("refuses git whose text cannot be verified statically", () => {
    expect(check("bash", { command: 'git commit -m "$(cat msg.txt)"' })).toBeDefined();
    expect(check("bash", { command: "git commit -m `cat msg.txt`" })).toBeDefined();
    expect(check("bash", { command: "git log ${!ref}" })).toBeDefined();
  });

  it("allows plain git and plain non-git commands", () => {
    expect(check("bash", { command: "git status && git diff" })).toBeUndefined();
    expect(check("bash", { command: 'git commit -m "fix: thing"' })).toBeUndefined();
    expect(check("bash", { command: "npm test" })).toBeUndefined();
    // A dynamic expansion with no git in play is not our business.
    expect(check("bash", { command: 'echo "$(date)"' })).toBeUndefined();
  });

  it("leaves unrelated tools untouched", () => {
    expect(check("glob", { pattern: "**/*" })).toBeUndefined();
    expect(check("webfetch", { url: "https://example.com" })).toBeUndefined();
  });
});

describe("worktree isolation — relative paths follow the command's real cwd", () => {
  // Real directories on purpose: targets are canonicalized before comparison,
  // so a fake `/parent` next to the real `/tmp` would test the fixture (macOS
  // `/tmp` is a symlink to `/private/tmp`) rather than the rule.
  let base: string;
  let main: string;
  let workspace: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "nova-guard-cwd-")));
    main = join(base, "repo");
    workspace = join(main, ".nova", "worktrees", "first");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(main, "sub"), { recursive: true });
    await mkdir(join(base, "other-repo"), { recursive: true });
    await mkdir(join(base, "other"), { recursive: true });
    await mkdir(join(base, "x"), { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const check = (command: string, cwd: string = base) =>
    worktreeIsolationDenial({
      main,
      workspace,
      checkouts: [workspace],
      tool: "bash",
      input: { command, cwd },
    })?.reason;

  it("resolves a relative git -C target against the tool's cwd, not the workspace", () => {
    // The command runs in the parent of `repo`, so `repo` is the main checkout
    // there. The old code resolved it against the worktree and let it through.
    expect(check("git -C repo rev-parse --show-toplevel")).toBeDefined();
  });

  it("resolves a cd target against the tool's cwd", () => {
    expect(check("cd repo && git status")).toBeDefined();
    expect(check('cd "repo" && git status')).toBeDefined();
    expect(check("cd repo/sub")).toBeDefined();
  });

  it("follows a chain of cds", () => {
    expect(check("cd other && cd ../repo && git log")).toBeDefined();
  });

  it("follows composed -C flags", () => {
    // x -> -C .. -> base -> -C repo -> <base>/repo (the main checkout)
    expect(check("git -C .. -C repo status", join(base, "x"))).toBeDefined();
  });

  it("allows the same shapes when they stay outside the main checkout", () => {
    expect(check("git status")).toBeUndefined();
    expect(check("git -C other-repo status")).toBeUndefined();
    expect(check("cd other && git status")).toBeUndefined();
  });

  it("refuses an unverifiable cd only when the command also runs git", () => {
    expect(check('cd "$TARGET" && git status')).toBeDefined();
    expect(check('cd "$TARGET" && ls')).toBeUndefined();
  });
});

describe("worktree isolation — git redirect env (WT08)", () => {
  it("refuses monitor env that points git at the main checkout", () => {
    expect(
      checkFromParent("monitor", {
        command: "git rev-parse --show-toplevel",
        env: { GIT_DIR: `${PARENT_MAIN}/.git` },
      }),
    ).toBeDefined();
    expect(
      checkFromParent("monitor", {
        command: "git status",
        env: { GIT_WORK_TREE: PARENT_MAIN },
      }),
    ).toBeDefined();
    expect(
      checkFromParent("monitor", {
        command: "git status",
        env: { GIT_INDEX_FILE: `${PARENT_MAIN}/.git/index` },
      }),
    ).toBeDefined();
  });

  it("resolves a relative env value against the command's cwd", () => {
    expect(
      checkFromParent("monitor", {
        cwd: PARENT,
        command: "git status",
        env: { GIT_DIR: "repo/.git" },
      }),
    ).toBeDefined();
  });

  it("refuses an env value whose target can't be verified", () => {
    expect(
      checkFromParent("monitor", { command: "git status", env: { GIT_DIR: "$HOME/x" } }),
    ).toBeDefined();
  });

  it("checks background bash (which forwards env) but not foreground bash (which ignores it)", () => {
    const env = { GIT_DIR: `${PARENT_MAIN}/.git` };
    expect(
      checkFromParent("bash", { command: "git status", run_in_background: true, env }),
    ).toBeDefined();
    // Foreground bash never sees `env` — denying on it would be a false positive.
    expect(checkFromParent("bash", { command: "git status", env })).toBeUndefined();
  });

  it("leaves unrelated environment variables alone", () => {
    expect(
      checkFromParent("monitor", { command: "npm test", env: { NODE_ENV: "test", PORT: "3000" } }),
    ).toBeUndefined();
  });
});

describe("worktree isolation — separate git dir, main checkout not derivable", () => {
  // A layout git cannot describe: the working trees live outside the git dir,
  // and `git worktree list` reports the GIT DIR as the "main worktree". The
  // guard therefore classifies a target against the shared git dir instead of
  // comparing against a main-checkout path it does not have.
  let base: string;
  let commonDir: string;
  let mainWork: string;
  let worktree: string;
  let sibling: string;
  let otherRepo: string;

  const deny = (tool: string, input: Record<string, unknown>, path?: string) =>
    worktreeIsolationDenial({
      workspace: worktree,
      gitDir: commonDir,
      checkouts: [],
      tool,
      input,
      ...(path ? { path } : {}),
    })?.reason;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "nova-guard-sep-")));
    commonDir = join(base, "metadata", "gitdir");
    mainWork = join(base, "work");
    worktree = join(base, "wt");
    sibling = join(base, "wt2");
    otherRepo = join(base, "other");

    await mkdir(join(commonDir, "worktrees", "wt"), { recursive: true });
    await mkdir(join(commonDir, "worktrees", "wt2"), { recursive: true });
    await mkdir(mainWork, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await mkdir(join(otherRepo, ".git"), { recursive: true });

    // The main working tree points AT the shared dir; the linked ones at
    // `<common>/worktrees/<name>`.
    await writeFile(join(mainWork, ".git"), `gitdir: ${commonDir}\n`);
    await writeFile(join(worktree, ".git"), `gitdir: ${join(commonDir, "worktrees", "wt")}\n`);
    await writeFile(join(sibling, ".git"), `gitdir: ${join(commonDir, "worktrees", "wt2")}\n`);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("refuses file writes into the undiscoverable main working tree", () => {
    expect(deny("write", { path: "x" }, join(mainWork, "a.txt"))).toMatch(
      /another checkout of this repository/,
    );
    // …including nested paths.
    expect(deny("edit", { path: "x" }, join(mainWork, "src", "deep", "a.ts"))).toBeDefined();
  });

  it("leaves the worktree, a sibling checkout and another repository alone", () => {
    expect(deny("write", { path: "x" }, join(worktree, "a.txt"))).toBeUndefined();
    expect(deny("write", { path: "x" }, join(sibling, "a.txt"))).toBeUndefined();
    expect(deny("write", { path: "x" }, join(otherRepo, "a.txt"))).toBeUndefined();
  });

  it("refuses commands that cd or redirect git into it", () => {
    expect(deny("bash", { command: `cd ${mainWork} && git status` })).toBeDefined();
    expect(deny("bash", { command: `git -C ${mainWork} status` })).toBeDefined();
    expect(deny("bash", { command: "cd ../work && git status" })).toBeDefined();
    expect(deny("bash", { command: "git status", cwd: mainWork })).toBeDefined();
  });

  it("refuses git redirection at the main checkout's private git state (WT14)", () => {
    // `<common>` is the MAIN checkout's git dir: its HEAD, index, config and
    // hooks. Pointing GIT_DIR at it stages into the main index (see the real-git
    // test below), so it must be refused — even though the path is not inside a
    // working tree, which is why the working-tree rule alone misses it.
    expect(deny("monitor", { command: "git status", env: { GIT_DIR: commonDir } })).toBeDefined();
    expect(deny("bash", { command: `GIT_DIR=${commonDir} git add x` })).toBeDefined();
    expect(deny("bash", { command: `git --git-dir=${commonDir} add x` })).toBeDefined();
    expect(
      deny("monitor", { command: "git status", env: { GIT_INDEX_FILE: join(commonDir, "index") } }),
    ).toBeDefined();
    expect(
      deny("monitor", { command: "git status", env: { GIT_CONFIG: join(commonDir, "config") } }),
    ).toBeDefined();
    // A checkout's `.git` entry is the same state by another name.
    expect(
      deny("monitor", { command: "git status", env: { GIT_DIR: join(mainWork, ".git") } }),
    ).toBeDefined();
    expect(
      deny("monitor", { command: "git status", env: { GIT_WORK_TREE: mainWork } }),
    ).toBeDefined();
  });

  it("still allows the parts of the common dir a worktree legitimately uses", () => {
    // The shared object store is content addressed — writing a new object there
    // is exactly what a normal commit does…
    expect(
      deny("bash", { command: `GIT_OBJECT_DIRECTORY=${join(commonDir, "objects")} git add .` }),
    ).toBeUndefined();
    // …and each checkout owns `<common>/worktrees/<name>` (its HEAD and index).
    expect(
      deny("monitor", {
        command: "git status",
        env: { GIT_DIR: join(commonDir, "worktrees", "wt") },
      }),
    ).toBeUndefined();
  });

  it("allows the same shapes when they stay outside the repository", () => {
    expect(deny("bash", { command: `git -C ${otherRepo} status` })).toBeUndefined();
    expect(deny("bash", { command: "cd ../wt2 && git status" })).toBeUndefined();
  });
});

describe("worktree isolation — symlinks resolve to their real target (WT13)", () => {
  let base: string;
  let main: string;
  let worktree: string;

  const deny = (tool: string, input: Record<string, unknown>, path?: string) =>
    worktreeIsolationDenial({
      main,
      workspace: worktree,
      checkouts: [worktree],
      tool,
      input,
      ...(path ? { path } : {}),
    })?.reason;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "nova-guard-link-")));
    main = join(base, "repo");
    worktree = join(main, ".nova", "worktrees", "feat");
    await mkdir(join(worktree, "sub"), { recursive: true });
    await mkdir(join(main, "src"), { recursive: true });
    // A path inside the worktree that really lands in the main checkout…
    await symlink(main, join(worktree, "main-link"));
    // …and the reverse: lexically under the main checkout, really in the
    // worktree.
    await symlink(worktree, join(main, "wt-link"));
    // A link that stays inside the worktree.
    await symlink(join(worktree, "sub"), join(worktree, "self-link"));
    // A link to a SUBDIRECTORY of the main checkout, so `main-src-link/..` is
    // the main checkout itself (the `link/..` traversal case).
    await symlink(join(main, "src"), join(worktree, "main-src-link"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("refuses a command path that is a symlink into the main checkout", () => {
    expect(deny("bash", { command: "git -C main-link status" })).toBeDefined();
    expect(deny("bash", { command: "git --git-dir=main-link/.git status" })).toBeDefined();
    expect(deny("bash", { command: "GIT_DIR=main-link/.git git status" })).toBeDefined();
    expect(deny("bash", { command: "cd main-link && git status" })).toBeDefined();
    expect(deny("bash", { command: "cd main-link/src && git status" })).toBeDefined();
  });

  it("refuses a file write through a symlink into the main checkout", () => {
    expect(deny("write", { path: "x" }, join(worktree, "main-link", "README.md"))).toBeDefined();
  });

  it("resolves `..` after a symlink before judging the target (WT13)", () => {
    // `main-src-link` -> <main>/src, so `..` is the MAIN checkout — a lexical
    // fold would leave the guard inside the worktree and let this through.
    expect(deny("bash", { command: "git -C main-src-link/.. status" })).toBeDefined();
    expect(deny("bash", { command: "cd main-src-link/.. && git status" })).toBeDefined();
    expect(deny("bash", { command: "GIT_DIR=main-src-link/../.git git status" })).toBeDefined();
    // …while `..` off a link that stays inside resolves inside.
    expect(deny("bash", { command: "git -C self-link/.. status" })).toBeUndefined();
  });

  it("allows a symlink that resolves back inside the worktree", () => {
    // The old lexical containment test flagged this: `main/wt-link` looks like
    // the main checkout but is really the worktree.
    expect(deny("bash", { command: "git -C wt-link status" })).toBeUndefined();
    expect(deny("bash", { command: "cd wt-link && git status" })).toBeUndefined();
    expect(deny("bash", { command: "git -C self-link status" })).toBeUndefined();
    expect(deny("write", { path: "x" }, join(main, "wt-link", "README.md"))).toBeUndefined();
  });
});

describe("worktree isolation — the shared git dir is main-checkout state (WT14, real git)", () => {
  let base: string;
  let work: string;
  let common: string;
  let wt: string;

  const guard = (tool: string, input: Record<string, unknown>) =>
    worktreeIsolationDenial({ gitDir: common, workspace: wt, checkouts: [wt], tool, input })
      ?.reason;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "nova-guard-gitstate-")));
    work = join(base, "work");
    common = join(base, "metadata", "gitdir");
    wt = join(base, "wt");
    await mkdir(work, { recursive: true });
    await mkdir(join(base, "metadata"), { recursive: true });
    expect(
      (await runGit(work, ["init", "-q", "--separate-git-dir", common, "-b", "main", "."])).code,
    ).toBe(0);
    await runGit(work, ["config", "user.email", "test@example.com"]);
    await runGit(work, ["config", "user.name", "Test"]);
    await writeFile(join(work, "README.md"), "hi\n");
    await runGit(work, ["add", "."]);
    expect((await runGit(work, ["commit", "-q", "-m", "init"])).code).toBe(0);
    expect((await runGit(work, ["worktree", "add", "-q", wt, "-b", "feat"])).code).toBe(0);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("a real GIT_DIR=<common> stages into the MAIN index — which is why it is refused", async () => {
    await writeFile(join(wt, "marker.txt"), "x\n");

    // Normal worktree git: objects land in the shared store, the index is this
    // checkout's own.
    expect((await runGit(wt, ["add", "marker.txt"])).code).toBe(0);
    expect((await runGit(wt, ["diff", "--cached", "--name-only"])).stdout).toContain("marker.txt");
    expect((await runGit(work, ["diff", "--cached", "--name-only"])).stdout).not.toContain(
      "marker.txt",
    );
    expect((await runGit(wt, ["reset", "-q"])).code).toBe(0);

    // The same add with GIT_DIR=<common>: git uses the main checkout's HEAD and
    // index, so the staging happens there while the worktree looks untouched.
    expect((await runGit(wt, ["--git-dir", common, "add", "marker.txt"])).code).toBe(0);
    expect((await runGit(work, ["diff", "--cached", "--name-only"])).stdout).toContain(
      "marker.txt",
    );
    expect((await runGit(wt, ["diff", "--cached", "--name-only"])).stdout).not.toContain(
      "marker.txt",
    );

    // …and the guard refuses exactly that shape, in the text and in `env`.
    expect(guard("bash", { command: `GIT_DIR=${common} git add marker.txt` })).toBeDefined();
    expect(
      guard("monitor", { command: "git add marker.txt", env: { GIT_DIR: common } }),
    ).toBeDefined();
    expect(guard("bash", { command: `git --git-dir=${common} add marker.txt` })).toBeDefined();

    // Normal add/commit in the worktree still works.
    await runGit(wt, ["reset", "-q"]);
    await writeFile(join(wt, "ok.txt"), "ok\n");
    expect((await runGit(wt, ["add", "ok.txt"])).code).toBe(0);
    expect((await runGit(wt, ["commit", "-q", "-m", "worktree commit"])).code).toBe(0);
  }, 30_000);

  it("applies the same redirect rule to GIT_* bindings behind `env` (WT16)", async () => {
    // The wrapper only moves the binding out of the command's argument list;
    // it must not move it out of the check.
    expect(guard("bash", { command: `env GIT_DIR=${common} git add marker.txt` })).toBeDefined();
    expect(
      guard("bash", { command: `env GIT_DIR=${join(work, ".git")} git status` }),
    ).toBeDefined();
    expect(guard("bash", { command: `env GIT_WORK_TREE=${work} git status` })).toBeDefined();
    expect(
      guard("bash", { command: `env GIT_INDEX_FILE=${join(common, "index")} git status` }),
    ).toBeDefined();
    // A nested shell inherits the environment, so the binding still applies.
    expect(
      guard("bash", { command: `env GIT_DIR=${common} bash -c "git add marker.txt"` }),
    ).toBeDefined();
    // Relative values resolve against the directory `env -C` moved the child to.
    expect(guard("bash", { command: `env -C ${work} GIT_DIR=.git git status` })).toBeDefined();

    // Legitimate uses stay allowed: ordinary variables, `-u`, and this
    // checkout's own per-worktree git dir.
    expect(guard("bash", { command: "env CI=1 git status" })).toBeUndefined();
    expect(guard("bash", { command: "env -u GIT_DIR git status" })).toBeUndefined();
    expect(
      guard("bash", { command: `env GIT_DIR=${join(common, "worktrees", "wt")} git status` }),
    ).toBeUndefined();

    // And the refused shape is exactly the one that stages into the MAIN index.
    await writeFile(join(wt, "marker.txt"), "x\n");
    execFileSync("bash", ["-c", `env GIT_DIR=${common} git add marker.txt`], {
      cwd: wt,
      stdio: "ignore",
    });
    expect((await runGit(work, ["diff", "--cached", "--name-only"])).stdout).toContain(
      "marker.txt",
    );
    expect((await runGit(wt, ["diff", "--cached", "--name-only"])).stdout).not.toContain(
      "marker.txt",
    );
  }, 30_000);
});

describe("worktree isolation — shell scope and branches (WT12)", () => {
  let base: string;
  let main: string;
  let workspace: string;

  const check = (command: string) =>
    worktreeIsolationDenial({
      main,
      workspace,
      checkouts: [workspace],
      tool: "bash",
      input: { command },
    })?.reason;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "nova-guard-scope-")));
    main = join(base, "repo");
    workspace = join(main, ".nova", "worktrees", "feat");
    await mkdir(join(workspace, "sub"), { recursive: true });
    await mkdir(join(main, "src"), { recursive: true });
    await mkdir(join(base, "outside"), { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("does not let a subshell's cd move the outer shell", () => {
    // The real shell runs git from `feat`, so `-C ..` reaches `.nova/worktrees`
    // and git discovers the main checkout from there.
    expect(check("(cd sub); git -C .. rev-parse --show-toplevel")).toBeDefined();
    expect(check("(cd sub; git status); git -C .. log")).toBeDefined();
  });

  it("does not let a failed cd move the shell", () => {
    // `cd` to a missing directory fails, so the `||` branch runs in `feat`.
    expect(check("cd nonexistent || git -C .. rev-parse --show-toplevel")).toBeDefined();
    expect(check("cd nonexistent; git -C .. status")).toBeDefined();
  });

  it("does not let a pipeline's cd move the shell", () => {
    expect(check("cd sub | cat; git -C .. status")).toBeDefined();
    // A background job is a subshell too.
    expect(check("cd sub & git -C .. status")).toBeDefined();
  });

  it("keeps a successful sequential cd as the base", () => {
    expect(check("cd sub; git -C . status")).toBeUndefined();
    expect(check(`cd ${join(base, "outside")}; git status`)).toBeUndefined();
    expect(check("cd sub && git -C . status")).toBeUndefined();
  });

  it("follows a brace group's cd — braces are not a scope", () => {
    expect(check("{ cd ..; git status; }")).toBeDefined();
  });

  it("refuses env/chdir and pushd moves", () => {
    expect(check(`env -C ${main} git add .`)).toBeDefined();
    expect(check("env -C .. git status")).toBeDefined();
    expect(check(`pushd ${main} && git status`)).toBeDefined();
  });

  it("refuses a nested script that cds into the main checkout", () => {
    expect(check(`bash -c "cd ${main} && git add ."`)).toBeDefined();
    expect(check(`sh -c 'cd .. && git status'`)).toBeDefined();
    expect(check(`bash -lc "cd ${main}; git status"`)).toBeDefined();
    expect(check(`eval "cd ${main} && git status"`)).toBeDefined();
  });

  it("keeps a nested shell's cd out of the caller", () => {
    // `cd sub` inside the subshell stays inside, so the outer `git -C .` is fine.
    expect(check("bash -c 'cd sub'; git -C . status")).toBeUndefined();
  });
});

describe("worktree isolation — agrees with a real shell (WT12)", () => {
  let base: string;
  let main: string;
  let workspace: string;

  const sh = (command: string): Promise<{ stdout: string; code: number }> =>
    new Promise((resolvePromise) => {
      execFile("bash", ["-c", command], { cwd: workspace, encoding: "utf8" }, (err, stdout) => {
        resolvePromise({ stdout: stdout ?? "", code: err ? 1 : 0 });
      });
    });

  const guard = (command: string) =>
    worktreeIsolationDenial({
      main,
      workspace,
      checkouts: [workspace],
      tool: "bash",
      input: { command },
    })?.reason;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "nova-guard-shell-")));
    main = join(base, "repo");
    workspace = join(main, ".nova", "worktrees", "feat");
    await mkdir(main, { recursive: true });
    expect((await runGit(main, ["init", "-q", "-b", "main"])).code).toBe(0);
    await runGit(main, ["config", "user.email", "test@example.com"]);
    await runGit(main, ["config", "user.name", "Test"]);
    await writeFile(join(main, "README.md"), "hi\n");
    await runGit(main, ["add", "."]);
    expect((await runGit(main, ["commit", "-q", "-m", "init"])).code).toBe(0);
    await mkdir(join(main, ".nova", "worktrees"), { recursive: true });
    expect((await runGit(main, ["worktree", "add", "-q", workspace, "-b", "feat"])).code).toBe(0);
    await mkdir(join(workspace, "sub"), { recursive: true });
    // Symlink fixtures for the `link/..` cases: a link into a main subdirectory
    // (so `..` is the main checkout) and one that stays in the worktree.
    await mkdir(join(main, "sub"), { recursive: true });
    await symlink(join(main, "sub"), join(workspace, "main-link"));
    await symlink(join(workspace, "sub"), join(workspace, "inner-link"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("refuses exactly the shapes whose git really lands in the main checkout", async () => {
    const cases = [
      "(cd sub); git -C .. rev-parse --show-toplevel",
      "cd nonexistent || git -C .. rev-parse --show-toplevel",
      "cd sub | cat; git -C .. rev-parse --show-toplevel",
      `env -C .. git rev-parse --show-toplevel`,
      `bash -c "cd ${main} && git rev-parse --show-toplevel"`,
      // …and the safe neighbours, where git really stays in the worktree.
      "cd sub; git -C . rev-parse --show-toplevel",
      "cd sub && git -C .. rev-parse --show-toplevel",
      "git rev-parse --show-toplevel",
      // Symlink traversal: `..` applies to the RESOLVED target, so a link into
      // the main checkout escapes even though the literal path looks local.
      "git -C main-link rev-parse --show-toplevel",
      "git -C main-link/.. rev-parse --show-toplevel",
      "git -C inner-link/.. rev-parse --show-toplevel",
    ];

    for (const command of cases) {
      const run = await sh(command);
      expect(run.code, command).toBe(0);
      const seen = await realpath(run.stdout.trim());
      const reachedMain = seen === main;
      // The guard's verdict must match where the real shell's git ended up:
      // refused iff the command touched the main checkout.
      expect(Boolean(guard(command)), `${command} → ${seen}`).toBe(reachedMain);
    }
  }, 30_000);
});
