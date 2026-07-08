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

/** Simulate a write/edit tool: capture prior state, write, record result. */
const toolWrite = async (store: SnapshotStore, file: string, content: string): Promise<void> => {
  await store.capture(file);
  await writeFile(file, content);
  await store.recordResult(file);
};

describe("SnapshotStore", () => {
  it("restores a modified file to its captured pre-turn content", async () => {
    const file = join(work, "a.ts");
    await writeFile(file, "v1");
    const store = new SnapshotStore(snapDir);

    store.setEpoch(0);
    await toolWrite(store, file, "v2");

    const plan = await store.plan(0);
    expect(plan.toModify).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
    await store.restore(plan);

    expect(await readFile(file, "utf8")).toBe("v1");
  });

  it("deletes a file that was created at/after the target turn", async () => {
    const file = join(work, "new.ts");
    const store = new SnapshotStore(snapDir);

    store.setEpoch(4);
    await toolWrite(store, file, "fresh"); // file does not exist yet → "create"

    const plan = await store.plan(4);
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
    await store.recordResult(file);

    store.setEpoch(8);
    await toolWrite(store, file, "after-turn2");

    // Rewind to turn 2 (epoch 8): only the turn-2 change is undone.
    await store.restore(await store.plan(8));
    expect(await readFile(file, "utf8")).toBe("after-turn1");

    // Rewind further to turn 1 (epoch 0): back to the original baseline.
    await store.restore(await store.plan(0));
    expect(await readFile(file, "utf8")).toBe("turn1-base");
  });

  it("leaves files changed before the target untouched", async () => {
    const file = join(work, "c.ts");
    await writeFile(file, "base");
    const store = new SnapshotStore(snapDir);

    store.setEpoch(0);
    await toolWrite(store, file, "edited-at-turn-0");

    // Rewinding to a later epoch must not roll back the epoch-0 change.
    const plan = await store.plan(5);
    expect(plan.toModify).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
    await store.restore(plan);
    expect(await readFile(file, "utf8")).toBe("edited-at-turn-0");
  });

  it("survives reload from disk (resume) and prunes consumed records", async () => {
    const file = join(work, "d.ts");
    await writeFile(file, "orig");
    const a = new SnapshotStore(snapDir);
    a.setEpoch(2);
    await toolWrite(a, file, "changed");

    // Fresh store pointed at the same dir, as after /resume.
    const b = new SnapshotStore(snapDir);
    await b.load();
    await b.restore(await b.plan(2));
    expect(await readFile(file, "utf8")).toBe("orig");

    // Records were pruned; the on-disk index reflects that.
    expect((await b.plan(2)).toModify).toHaveLength(0);
    const idx = await readFile(join(snapDir, "index.jsonl"), "utf8");
    expect(idx.trim()).toBe("");
  });

  it("flags a file changed outside nova as a conflict and never overwrites it", async () => {
    const file = join(work, "e.ts");
    await writeFile(file, "v1");
    const store = new SnapshotStore(snapDir);

    store.setEpoch(0);
    await toolWrite(store, file, "v2"); // nova's write

    // Something else (bash / sub-agent / another session / the user) moves the
    // file past nova's last write.
    await writeFile(file, "v3-latest");

    const plan = await store.plan(0);
    expect(plan.toModify).toHaveLength(0);
    expect(plan.conflicts).toEqual([{ path: file, kind: "modify" }]);

    await store.restore(plan);
    // The user's newer content survives — rewind did not clobber it.
    expect(await readFile(file, "utf8")).toBe("v3-latest");
  });

  it("does not delete a created file that was changed outside nova", async () => {
    const file = join(work, "f.ts");
    const store = new SnapshotStore(snapDir);

    store.setEpoch(3);
    await toolWrite(store, file, "nova-made"); // create

    await writeFile(file, "hand-edited-latest"); // diverged after creation

    const plan = await store.plan(3);
    expect(plan.toRemove).toHaveLength(0);
    expect(plan.conflicts).toEqual([{ path: file, kind: "create" }]);

    await store.restore(plan);
    expect(await readFile(file, "utf8")).toBe("hand-edited-latest");
  });

  it("treats a path with no recorded result (older session) as a conflict", async () => {
    const file = join(work, "g.ts");
    await writeFile(file, "v1");
    const store = new SnapshotStore(snapDir);

    // capture without recordResult — mimics a snapshot taken before results
    // tracking existed.
    store.setEpoch(0);
    await store.capture(file);
    await writeFile(file, "v2");

    const plan = await store.plan(0);
    expect(plan.toModify).toHaveLength(0);
    expect(plan.conflicts).toEqual([{ path: file, kind: "modify" }]);
  });

  it("persists result hashes across reload so verification survives resume", async () => {
    const file = join(work, "h.ts");
    await writeFile(file, "v1");
    const a = new SnapshotStore(snapDir);
    a.setEpoch(0);
    await toolWrite(a, file, "v2");

    // Reload, then diverge the file — the reloaded store must still recognise
    // the drift rather than treating the path as unverifiable.
    const b = new SnapshotStore(snapDir);
    await b.load();
    await writeFile(file, "v3-latest");

    const plan = await b.plan(0);
    expect(plan.toModify).toHaveLength(0);
    expect(plan.conflicts).toEqual([{ path: file, kind: "modify" }]);
  });
});
