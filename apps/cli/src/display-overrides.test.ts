import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDisplayOverride,
  clearDisplayOverrides,
  displayOverridesPath,
  loadDisplayOverrides,
} from "./display-overrides.js";

describe("display overrides sidecar", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nova-display-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty map when the file is absent", async () => {
    expect(await loadDisplayOverrides(dir)).toEqual({});
  });

  it("round-trips appended records into a map", async () => {
    await appendDisplayOverride(dir, "EXPANDED a", "/agent a task");
    await appendDisplayOverride(dir, "EXPANDED b", "/plan b");
    expect(await loadDisplayOverrides(dir)).toEqual({
      "EXPANDED a": "/agent a task",
      "EXPANDED b": "/plan b",
    });
  });

  it("lets a later record win on key collision (append-only dedup)", async () => {
    await appendDisplayOverride(dir, "K", "first");
    await appendDisplayOverride(dir, "K", "second");
    expect(await loadDisplayOverrides(dir)).toEqual({ K: "second" });
  });

  it("skips malformed lines rather than throwing", async () => {
    await appendDisplayOverride(dir, "good", "/x");
    await writeFile(
      displayOverridesPath(dir),
      `not json\n{"expanded":123}\n{"expanded":"ok","raw":"/y"}\n`,
      { flag: "a" },
    );
    expect(await loadDisplayOverrides(dir)).toEqual({ good: "/x", ok: "/y" });
  });

  it("clear removes the sidecar and is a no-op when already gone", async () => {
    await appendDisplayOverride(dir, "K", "v");
    await clearDisplayOverrides(dir);
    expect(await loadDisplayOverrides(dir)).toEqual({});
    await expect(clearDisplayOverrides(dir)).resolves.toBeUndefined();
  });
});
