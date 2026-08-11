import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalUsageLedger, loadGlobalUsage, type LifetimeUsage } from "./global-usage.js";

const req = (uncached: number, read: number, creation = 0, output = 0) => ({
  inputTokens: uncached,
  outputTokens: output,
  cacheReadInputTokens: read,
  cacheCreationInputTokens: creation,
});

describe("loadGlobalUsage", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nova-usage-"));
    path = join(dir, "usage.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads back what the ledger wrote", async () => {
    await writeFile(
      path,
      JSON.stringify({
        cacheReadTokens: 900,
        cacheCreationTokens: 50,
        uncachedInputTokens: 50,
        outputTokens: 20,
      }),
      "utf8",
    );
    await expect(loadGlobalUsage(path)).resolves.toEqual({
      cacheReadTokens: 900,
      cacheCreationTokens: 50,
      uncachedInputTokens: 50,
      outputTokens: 20,
    });
  });

  it("reads a missing file as all-zero", async () => {
    await expect(loadGlobalUsage(join(dir, "absent.json"))).resolves.toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
    });
  });

  it("reads a malformed or half-written file as all-zero", async () => {
    await writeFile(path, '{"cacheReadTokens": 90', "utf8");
    await expect(loadGlobalUsage(path)).resolves.toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
    });
  });

  it("coerces junk fields to 0 rather than propagating NaN into the rate", async () => {
    await writeFile(
      path,
      JSON.stringify({ cacheReadTokens: "lots", cacheCreationTokens: -5, uncachedInputTokens: 10 }),
      "utf8",
    );
    const totals = await loadGlobalUsage(path);
    expect(totals.cacheReadTokens).toBe(0);
    expect(totals.cacheCreationTokens).toBe(0);
    expect(totals.uncachedInputTokens).toBe(10);
  });
});

describe("GlobalUsageLedger", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nova-usage-"));
    path = join(dir, "usage.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("batches requests and writes their sum on flush", async () => {
    const seen: LifetimeUsage[] = [];
    const ledger = new GlobalUsageLedger(path, (t) => seen.push(t));
    ledger.add(req(100, 0, 0, 5));
    ledger.add(req(0, 900, 0, 7));
    await ledger.flush();

    const written: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(written).toEqual({
      cacheReadTokens: 900,
      cacheCreationTokens: 0,
      uncachedInputTokens: 100,
      outputTokens: 12,
    });
    // The merged total is pushed back so the display converges on the file.
    expect(seen).toEqual([written]);
  });

  it("adds to an existing file rather than overwriting it", async () => {
    await writeFile(
      path,
      JSON.stringify({
        cacheReadTokens: 1000,
        cacheCreationTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
      }),
      "utf8",
    );
    const ledger = new GlobalUsageLedger(path);
    ledger.add(req(10, 90));
    await ledger.flush();
    await expect(loadGlobalUsage(path)).resolves.toMatchObject({
      cacheReadTokens: 1090,
      uncachedInputTokens: 10,
    });
  });

  it("re-reads before each flush, so a concurrent writer isn't clobbered", async () => {
    const ledger = new GlobalUsageLedger(path);
    ledger.add(req(0, 100));
    await ledger.flush();

    // Another nova process advances the same ledger behind our back.
    const other = new GlobalUsageLedger(path);
    other.add(req(0, 500));
    await other.flush();

    ledger.add(req(0, 300));
    await ledger.flush();
    // 100 + 500 + 300 — this ledger's second flush kept the other's spend.
    await expect(loadGlobalUsage(path)).resolves.toMatchObject({ cacheReadTokens: 900 });
  });

  it("flushes nothing when no usage was recorded", async () => {
    const ledger = new GlobalUsageLedger(path);
    await ledger.flush();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("does not double-count a delta already written", async () => {
    const ledger = new GlobalUsageLedger(path);
    ledger.add(req(0, 100));
    await ledger.flush();
    await ledger.flush();
    await expect(loadGlobalUsage(path)).resolves.toMatchObject({ cacheReadTokens: 100 });
  });
});
