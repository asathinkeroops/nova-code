import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureFresh,
  GuideProvisionError,
  resolveGuideDir,
  resolveGuideSourceDir,
} from "./provisioner.js";

const execFileP = promisify(execFile);

/** Run git in `cwd` with a fixed identity so commits work in a bare test env. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileP("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
  });
}

describe("resolveGuideDir", () => {
  it("expands ~ and anchors relative paths at home", () => {
    expect(resolveGuideDir("~/.nova/nova-code-guide", "/home/u")).toBe(
      "/home/u/.nova/nova-code-guide",
    );
    expect(resolveGuideDir("~", "/home/u")).toBe("/home/u");
    expect(resolveGuideDir("/abs/guide", "/home/u")).toBe("/abs/guide");
    expect(resolveGuideDir("rel/guide", "/home/u")).toBe("/home/u/rel/guide");
  });
});

describe("resolveGuideSourceDir", () => {
  it("remote resolves the cache dir under home", () => {
    expect(
      resolveGuideSourceDir(
        { source: "remote", cacheDir: "~/.nova/nova-code-guide" },
        "/ws",
        "/home/u",
      ),
    ).toBe("/home/u/.nova/nova-code-guide");
  });

  it("local honors an absolute localPath", () => {
    expect(
      resolveGuideSourceDir(
        { source: "local", cacheDir: "~/x", localPath: "/abs/nova" },
        "/ws",
        "/home/u",
      ),
    ).toBe("/abs/nova");
  });

  it("local resolves a relative localPath against the workspace", () => {
    expect(
      resolveGuideSourceDir(
        { source: "local", cacheDir: "~/x", localPath: "sub/nova" },
        "/ws",
        "/home/u",
      ),
    ).toBe("/ws/sub/nova");
  });

  it("local expands ~ in localPath against home", () => {
    expect(
      resolveGuideSourceDir(
        { source: "local", cacheDir: "~/x", localPath: "~/nova" },
        "/ws",
        "/home/u",
      ),
    ).toBe("/home/u/nova");
  });

  it("local falls back to the workspace when localPath is unset", () => {
    expect(resolveGuideSourceDir({ source: "local", cacheDir: "~/x" }, "/ws", "/home/u")).toBe(
      "/ws",
    );
  });
});

describe("ensureFresh", () => {
  let origin: string;
  let home: string;
  let cacheDir: string;

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), "guide-origin-"));
    home = await mkdtemp(join(tmpdir(), "guide-home-"));
    cacheDir = join(home, ".nova", "nova-code-guide");
    // A tiny origin repo with one commit on `main`.
    await git(origin, "init", "-b", "main");
    await writeFile(join(origin, "README.md"), "v1");
    await git(origin, "add", ".");
    await git(origin, "commit", "-m", "v1");
  });

  afterEach(async () => {
    await rm(origin, { recursive: true, force: true }).catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  const opts = () => ({ repoUrl: origin, ref: "main", cacheDir, home });

  it("clones the source on first run", async () => {
    const res = await ensureFresh(opts());
    expect(res.dir).toBe(cacheDir);
    expect(res.refreshed).toBe(true);
    expect(res.offline).toBe(false);
    expect(await readFile(join(cacheDir, "README.md"), "utf8")).toBe("v1");
  });

  it("pulls the latest source on a subsequent run", async () => {
    await ensureFresh(opts());
    await writeFile(join(origin, "README.md"), "v2");
    await git(origin, "commit", "-am", "v2");

    const res = await ensureFresh(opts());
    expect(res.refreshed).toBe(true);
    expect(res.offline).toBe(false);
    expect(await readFile(join(cacheDir, "README.md"), "utf8")).toBe("v2");
  });

  it("skips the network fetch when the checkout is within the freshness window", async () => {
    await ensureFresh(opts());
    await writeFile(join(origin, "README.md"), "v2");
    await git(origin, "commit", "-am", "v2");

    const res = await ensureFresh({ ...opts(), maxAgeMs: 60_000 });
    expect(res.refreshed).toBe(false);
    expect(res.offline).toBe(false);
    // Still the originally-cloned content — the fetch was throttled.
    expect(await readFile(join(cacheDir, "README.md"), "utf8")).toBe("v1");
  });

  it("refreshes when the freshness window is disabled (maxAgeMs 0)", async () => {
    await ensureFresh(opts());
    await writeFile(join(origin, "README.md"), "v2");
    await git(origin, "commit", "-am", "v2");

    const res = await ensureFresh({ ...opts(), maxAgeMs: 0 });
    expect(res.refreshed).toBe(true);
    expect(await readFile(join(cacheDir, "README.md"), "utf8")).toBe("v2");
  });

  it("reuses the cached checkout when a refresh fails (offline)", async () => {
    await ensureFresh(opts());
    // Remote gone → fetch fails, but the existing checkout stays usable.
    await rm(origin, { recursive: true, force: true });

    const res = await ensureFresh(opts());
    expect(res.refreshed).toBe(false);
    expect(res.offline).toBe(true);
    expect(await readFile(join(cacheDir, "README.md"), "utf8")).toBe("v1");
  });

  it("throws when the initial clone fails and there is no cache", async () => {
    await expect(
      ensureFresh({
        repoUrl: join(tmpdir(), "guide-nonexistent-repo"),
        ref: "main",
        cacheDir,
        home,
      }),
    ).rejects.toBeInstanceOf(GuideProvisionError);
  });
});
