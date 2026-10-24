import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool } from "./bash.js";
import { resolveToolCwd } from "./cwd.js";

/**
 * The tool boundary owns one job: turn a tool's optional `cwd` into the absolute
 * directory the command will actually run in. Before that, a relative `cwd` was
 * resolved by spawn/execa against the NODE PROCESS's cwd while the worktree
 * isolation gate resolved it against the session workspace — two answers to
 * "where does this run" once `/worktree` (or `--cwd`) moved the session away
 * from the launch directory.
 */
describe("resolveToolCwd", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "nova-tool-cwd-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to the session cwd", async () => {
    expect(await resolveToolCwd(undefined, root)).toBe(root);
  });

  it("resolves a relative cwd against the session cwd, not process.cwd()", async () => {
    expect(await resolveToolCwd(".", root)).toBe(root);
    expect(await resolveToolCwd("sub", root)).toBe(join(root, "sub"));
  });

  it("passes an absolute cwd through", async () => {
    const abs = join(root, "elsewhere");
    expect(await resolveToolCwd(abs, root)).toBe(abs);
  });

  it("resolves symlinks so a link cannot redirect the command elsewhere", async () => {
    const outside = join(root, "outside");
    const inside = join(root, "session");
    await mkdir(outside);
    await mkdir(inside);
    await symlink(outside, join(inside, "link"));
    expect(await resolveToolCwd("link", inside)).toBe(outside);
  });
});

describe("bash tool cwd", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "nova-bash-cwd-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // The regression test for the isolation bypass: vitest runs with
  // process.cwd() = the repo root, so only a real normalization makes these
  // commands print the SESSION directory.
  it("runs a relative cwd inside the session workspace", async () => {
    await mkdir(join(root, "sub"));
    const dot = await bashTool.run({ command: "pwd", cwd: "." }, { cwd: root });
    expect(dot.output.trim()).toBe(root);
    const sub = await bashTool.run({ command: "pwd", cwd: "sub" }, { cwd: root });
    expect(sub.output.trim()).toBe(join(root, "sub"));
  });

  it("runs with the session cwd when no cwd is given", async () => {
    const result = await bashTool.run({ command: "pwd" }, { cwd: root });
    expect(result.output.trim()).toBe(root);
  });
});

describe("bash tool env", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "nova-bash-env-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ignores env for foreground commands — the isolation guard must not deny on it", async () => {
    // Documented on the schema ("Only honoured when run_in_background is true"),
    // and the reason `worktreeIsolationDenial` checks env only for background
    // bash and monitor.
    const result = await bashTool.run(
      { command: 'echo "v=${NOVA_ENV_PROBE:-unset}"', env: { NOVA_ENV_PROBE: "applied" } },
      { cwd: root },
    );
    expect(result.output.trim()).toBe("v=unset");
  });
});
