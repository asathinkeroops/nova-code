import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "./context.js";
import {
  checkForUpdate,
  compareVersions,
  fetchLatestVersion,
  isNewerVersion,
  runUpgrade,
  shouldCheck,
  type UpdateCache,
} from "./update.js";

describe("isNewerVersion / compareVersions", () => {
  it("orders releases numerically", () => {
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.1.0", "1.0.9")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });

  it("treats a release as newer than its prerelease", () => {
    expect(isNewerVersion("1.0.0", "1.0.0-beta.3")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.3", "1.0.0")).toBe(false);
  });

  it("orders prereleases against each other", () => {
    expect(isNewerVersion("1.0.0-beta.3", "1.0.0-beta.2")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.3")).toBe(false);
    // numeric identifiers rank below alphanumeric ones
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    // longer identifier set wins when the prefix is equal
    expect(compareVersions("1.0.0-beta.1.2", "1.0.0-beta.1")).toBe(1);
  });

  it("ignores a leading v and build metadata", () => {
    expect(isNewerVersion("v1.2.0", "1.1.0")).toBe(true);
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
  });

  it("sorts unparseable input below any valid version", () => {
    expect(isNewerVersion("not-a-version", "1.0.0")).toBe(false);
    expect(compareVersions("garbage", "garbage")).toBe(0);
    expect(compareVersions("1.0.0", "garbage")).toBe(1);
  });
});

describe("shouldCheck", () => {
  const HOUR = 60 * 60 * 1000;
  it("checks when there is no cache", () => {
    expect(shouldCheck(null, 1_000_000, 24)).toBe(true);
  });
  it("skips within the interval", () => {
    const cache: UpdateCache = { lastCheckAt: 100 * HOUR, latestVersion: "1.0.0" };
    expect(shouldCheck(cache, 100 * HOUR + 1 * HOUR, 24)).toBe(false);
  });
  it("checks once the interval has elapsed", () => {
    const cache: UpdateCache = { lastCheckAt: 100 * HOUR, latestVersion: "1.0.0" };
    expect(shouldCheck(cache, 100 * HOUR + 25 * HOUR, 24)).toBe(true);
  });
});

describe("fetchLatestVersion", () => {
  it("returns the version from the registry manifest", async () => {
    const fake = vi.fn(async () => new Response(JSON.stringify({ version: "2.3.4" }), { status: 200 }));
    await expect(fetchLatestVersion("@scope/pkg", fake)).resolves.toBe("2.3.4");
  });
  it("returns null on a non-ok response", async () => {
    const fake = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(fetchLatestVersion("@scope/pkg", fake)).resolves.toBeNull();
  });
  it("returns null when fetch throws", async () => {
    const fake = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(fetchLatestVersion("@scope/pkg", fake)).resolves.toBeNull();
  });
});

describe("checkForUpdate", () => {
  let dir: string;
  let cachePath: string;
  const cards: Array<{ text: string; title?: string }> = [];

  function makeCtx(overrides: { enabled?: boolean; version?: string } = {}): CliContext {
    return {
      version: overrides.version ?? "1.0.0",
      settings: {
        update: {
          enabled: overrides.enabled ?? true,
          checkIntervalHours: 24,
          command: "echo upgrade",
        },
      },
      screen: {
        card: (text: string, opts?: { title?: string }) => cards.push({ text, title: opts?.title }),
      },
      logger: { debug: () => {} },
    } as unknown as CliContext;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nova-update-"));
    cachePath = join(dir, "update-check.json");
    cards.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("shows a card when a newer version is published and writes the cache", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "1.2.0" }), { status: 200 }));
    await checkForUpdate(makeCtx(), { now: 1_000, cachePath, fetchImpl, packageName: "@scope/pkg" });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe("update available");
    expect(cards[0]?.text).toContain("1.2.0");
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as UpdateCache;
    expect(cache).toMatchObject({ lastCheckAt: 1_000, latestVersion: "1.2.0" });
  });

  it("shows no card when already up to date", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }));
    await checkForUpdate(makeCtx(), { now: 1_000, cachePath, fetchImpl, packageName: "@scope/pkg" });
    expect(cards).toHaveLength(0);
  });

  it("bails out (no fetch, no card) when disabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await checkForUpdate(makeCtx({ enabled: false }), { now: 1_000, cachePath, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cards).toHaveLength(0);
  });

  it("reuses the cached version without fetching inside the throttle window", async () => {
    const cache: UpdateCache = { lastCheckAt: 5_000, latestVersion: "1.5.0" };
    await writeFile(cachePath, JSON.stringify(cache), "utf8");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    // 1h later — well within the 24h interval.
    await checkForUpdate(makeCtx(), { now: 5_000 + 60 * 60 * 1000, cachePath, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toContain("1.5.0");
  });

  it("swallows a fetch failure without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      checkForUpdate(makeCtx(), { now: 1_000, cachePath, fetchImpl, packageName: "@scope/pkg" }),
    ).resolves.toBeUndefined();
    expect(cards).toHaveLength(0);
  });
});

describe("runUpgrade", () => {
  it("runs the command and returns its exit code", async () => {
    await expect(runUpgrade("node -e process.exit(0)")).resolves.toBe(0);
  });
  it("returns non-zero when the command fails", async () => {
    await expect(runUpgrade("node -e process.exit(3)")).resolves.toBe(3);
  });
  it("returns 1 for an empty command", async () => {
    await expect(runUpgrade("   ")).resolves.toBe(1);
  });
});
