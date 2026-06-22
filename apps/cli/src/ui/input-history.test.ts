import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INPUT_HISTORY_LIMIT,
  appendInputHistory,
  loadInputHistory,
  saveInputHistory,
} from "./input-history.js";

describe("appendInputHistory", () => {
  it("appends a new entry as the newest (oldest first)", () => {
    expect(appendInputHistory(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("ignores empty / whitespace-only lines, returning the same array", () => {
    const history = ["a"];
    expect(appendInputHistory(history, "   ")).toBe(history);
    expect(appendInputHistory(history, "")).toBe(history);
  });

  it("de-duplicates MRU-style: a repeat moves to the end", () => {
    expect(appendInputHistory(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });

  it(`caps to the newest ${INPUT_HISTORY_LIMIT} entries`, () => {
    let history: string[] = [];
    for (let i = 0; i < INPUT_HISTORY_LIMIT + 5; i++) {
      history = appendInputHistory(history, `cmd-${i}`);
    }
    expect(history).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(history[0]).toBe("cmd-5");
    expect(history[history.length - 1]).toBe(`cmd-${INPUT_HISTORY_LIMIT + 4}`);
  });
});

describe("loadInputHistory / saveInputHistory", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nova-input-history-"));
    path = join(dir, "input-history.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips through disk", async () => {
    await saveInputHistory(["one", "two"], path);
    expect(await loadInputHistory(path)).toEqual(["one", "two"]);
  });

  it("returns [] for a missing file", async () => {
    expect(await loadInputHistory(join(dir, "nope.json"))).toEqual([]);
  });

  it("returns [] for malformed JSON", async () => {
    await writeFile(path, "{ not json", "utf8");
    expect(await loadInputHistory(path)).toEqual([]);
  });

  it("drops non-string entries from a tampered file", async () => {
    await writeFile(path, JSON.stringify(["a", 1, null, "b"]), "utf8");
    expect(await loadInputHistory(path)).toEqual(["a", "b"]);
  });

  it(`caps an oversized file to the newest ${INPUT_HISTORY_LIMIT} on load`, async () => {
    const big = Array.from({ length: INPUT_HISTORY_LIMIT + 4 }, (_, i) => `e-${i}`);
    await writeFile(path, JSON.stringify(big), "utf8");
    const loaded = await loadInputHistory(path);
    expect(loaded).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(loaded[0]).toBe("e-4");
  });

  it("caps on save so the file never grows past the limit", async () => {
    const big = Array.from({ length: INPUT_HISTORY_LIMIT + 4 }, (_, i) => `e-${i}`);
    await saveInputHistory(big, path);
    const onDisk: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(Array.isArray(onDisk) && onDisk).toHaveLength(INPUT_HISTORY_LIMIT);
  });
});
