import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotStore } from "./snapshots.js";

let root: string;
let snapDir: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nova-snap-"));
  snapDir = join(root, "snapshots");
  work = join(root, "work");
  await mkdir(work, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(() => true).catch(() => false);

describe("SnapshotStore", () => {
  it("restores a modified file to its captured pre-turn content", async () => {
    const file = join(work, "a.ts");
    await writeFile(file, "v1");
    const store = new SnapshotStore(snapDir);

    store.setEpoch(0);
    await store.capture(file); // baseline before turn 0's edits
    await writeFile(file, "v2"); // simulate the tool's write

    const plan = store.plan(0);
    expect(plan.toModify).toHaveLength(1);
    await store.restore(plan);

    expect(await readFile(file, "utf8")).toBe("v1");
  });

  it("deletes a file that was created at/after the target turn", async () => {
    const file = join(work, "new.ts");
    const store = new SnapshotStore(snapDir);

    store.setEpoch(4);
    await store.capture(file); // file does not exist yet → "create"
    await writeFile(file, "fresh");

    const plan = store.plan(4);
    expect(plan.toRemove).toEqual([file]);
    await store.restore(plan);

    expect(await exists(file)).toBe(false);
  });

  it("captures each path once per epoch but keeps per-epoch baselines", async () => {
    const file = join(work, "b.ts");
    await writeFile(file, "turn1-base");
    const store = new SnapshotStore(snapDir);

    store.setEpoch(0);
    await store.capture(file);
    await store.capture(file); // dedup within the same epoch — no-op
    await writeFile(file, "after-turn1");

    store.setEpoch(8);
    await store.capture(file);
    await writeFile(file, "after-turn2");

    // Rewind to turn 2 (epoch 8): only the turn-2 change is undone.
    await store.restore(store.plan(8));
    expect(await readFile(file, "utf8")).toBe("after-turn1");

    // Rewind further to turn 1 (epoch 0): back to the original baseline.
    await store.restore(store.plan(0));
    expect(await readFile(file, "utf8")).toBe("turn1-base");
  });

  it("leaves files changed before the target untouched", async () => {
    const file = join(work, "c.ts");
    await writeFile(file, "base");
    const store = new SnapshotStore(snapDir);

    store.setEpoch(0);
    await store.capture(file);
    await writeFile(file, "edited-at-turn-0");

    // Rewinding to a later epoch must not roll back the epoch-0 change.
    const plan = store.plan(5);
    expect(plan.toModify).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
    await store.restore(plan);
    expect(await readFile(file, "utf8")).toBe("edited-at-turn-0");
  });

  it("survives reload from disk (resume) and prunes consumed records", async () => {
    const file = join(work, "d.ts");
    await writeFile(file, "orig");
    const a = new SnapshotStore(snapDir);
    a.setEpoch(2);
    await a.capture(file);
    await writeFile(file, "changed");

    // Fresh store pointed at the same dir, as after /resume.
    const b = new SnapshotStore(snapDir);
    await b.load();
    await b.restore(b.plan(2));
    expect(await readFile(file, "utf8")).toBe("orig");

    // Records were pruned; the on-disk index reflects that.
    expect(b.plan(2).toModify).toHaveLength(0);
    const idx = await readFile(join(snapDir, "index.jsonl"), "utf8");
    expect(idx.trim()).toBe("");
  });
});
