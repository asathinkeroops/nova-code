import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "./store.js";

const SID = "test-session";
let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(tmpdir(), "nova-task-store-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("TaskStore.create", () => {
  it("creates a pending task with empty blockedBy and persists to disk", async () => {
    const store = new TaskStore(workspace, SID);
    const task = await store.create("write tests");
    expect(task.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(task.description).toBe("write tests");
    expect(task.blockedBy).toEqual([]);
    expect(task.status).toBe("pending");

    const onDisk = await fs.readFile(
      path.join(workspace, ".tasks", SID, `${task.id}.json`),
      "utf8",
    );
    expect(JSON.parse(onDisk)).toEqual(task);
  });

  it("rejects empty descriptions", async () => {
    const store = new TaskStore(workspace, SID);
    await expect(store.create("   ")).rejects.toThrow(/non-empty/);
  });

  it("trims description before storing", async () => {
    const store = new TaskStore(workspace, SID);
    const task = await store.create("  hello  ");
    expect(task.description).toBe("hello");
  });
});

describe("TaskStore.update — status", () => {
  it("applies a valid transition and persists", async () => {
    const store = new TaskStore(workspace, SID);
    const created = await store.create("x");
    const updated = await store.update(created.id, { status: "in_progress" });
    expect(updated.status).toBe("in_progress");

    const reloaded = new TaskStore(workspace, SID);
    const fromDisk = await reloaded.get(created.id);
    expect(fromDisk?.status).toBe("in_progress");
  });

  it("rejects invalid transitions (completed -> in_progress)", async () => {
    const store = new TaskStore(workspace, SID);
    const created = await store.create("x");
    await store.update(created.id, { status: "completed" });
    await expect(
      store.update(created.id, { status: "in_progress" }),
    ).rejects.toThrow(/invalid transition/);
  });

  it("allows multiple tasks to be in_progress simultaneously", async () => {
    const store = new TaskStore(workspace, SID);
    const a = await store.create("a");
    const b = await store.create("b");
    await store.update(a.id, { status: "in_progress" });
    await store.update(b.id, { status: "in_progress" });
    const all = await store.list("in_progress");
    expect(all).toHaveLength(2);
  });

  it("rejects unknown id", async () => {
    const store = new TaskStore(workspace, SID);
    await expect(store.update("nope", { status: "completed" })).rejects.toThrow(
      /not found/,
    );
  });
});

describe("TaskStore.update — blockedBy patch", () => {
  it("adds and removes ids, deduping silently", async () => {
    const store = new TaskStore(workspace, SID);
    const a = await store.create("a");
    await store.update(a.id, { addBlockedBy: ["x", "y"] });
    let task = await store.get(a.id);
    expect(task?.blockedBy.sort()).toEqual(["x", "y"]);

    // re-adding existing is a no-op
    await store.update(a.id, { addBlockedBy: ["x"] });
    task = await store.get(a.id);
    expect(task?.blockedBy.sort()).toEqual(["x", "y"]);

    // removing missing is a no-op
    await store.update(a.id, { removeBlockedBy: ["z"] });
    task = await store.get(a.id);
    expect(task?.blockedBy.sort()).toEqual(["x", "y"]);

    // remove existing
    await store.update(a.id, { removeBlockedBy: ["x"] });
    task = await store.get(a.id);
    expect(task?.blockedBy).toEqual(["y"]);
  });

  it("rejects self-reference in addBlockedBy", async () => {
    const store = new TaskStore(workspace, SID);
    const a = await store.create("a");
    await expect(
      store.update(a.id, { addBlockedBy: [a.id] }),
    ).rejects.toThrow(/self/);
  });

  it("rejects overlap between addBlockedBy and removeBlockedBy", async () => {
    const store = new TaskStore(workspace, SID);
    const a = await store.create("a");
    await expect(
      store.update(a.id, { addBlockedBy: ["x"], removeBlockedBy: ["x"] }),
    ).rejects.toThrow(/overlap/);
  });

  it("rejects no-op calls (no status, no add, no remove)", async () => {
    const store = new TaskStore(workspace, SID);
    const a = await store.create("a");
    await expect(store.update(a.id, {})).rejects.toThrow(/at least one/);
    await expect(
      store.update(a.id, { addBlockedBy: [], removeBlockedBy: [] }),
    ).rejects.toThrow(/at least one/);
  });

  it("applies status and blockedBy patch in one call", async () => {
    const store = new TaskStore(workspace, SID);
    const a = await store.create("a");
    const updated = await store.update(a.id, {
      status: "in_progress",
      addBlockedBy: ["x"],
    });
    expect(updated.status).toBe("in_progress");
    expect(updated.blockedBy).toEqual(["x"]);
  });
});

describe("TaskStore.list and get", () => {
  it("lists all tasks and filters by status", async () => {
    const store = new TaskStore(workspace, SID);
    const a = await store.create("a");
    await store.create("b");
    await store.update(a.id, { status: "completed" });

    const all = await store.list();
    expect(all).toHaveLength(2);

    const done = await store.list("completed");
    expect(done).toHaveLength(1);
    expect(done[0]?.id).toBe(a.id);
  });

  it("get returns undefined for unknown id", async () => {
    const store = new TaskStore(workspace, SID);
    expect(await store.get("missing")).toBeUndefined();
  });
});

describe("TaskStore persistence", () => {
  it("loads existing tasks from disk on first access", async () => {
    const a = new TaskStore(workspace, SID);
    const t1 = await a.create("first");
    const t2 = await a.create("second");
    await a.update(t2.id, { status: "in_progress", addBlockedBy: [t1.id] });

    const b = new TaskStore(workspace, SID);
    const list = await b.list();
    expect(list).toHaveLength(2);
    const reloaded = await b.get(t2.id);
    expect(reloaded?.status).toBe("in_progress");
    expect(reloaded?.blockedBy).toEqual([t1.id]);
  });

  it("tolerates missing .tasks/{sessionId} directory on first call", async () => {
    const store = new TaskStore(path.join(workspace, "nonexistent"), SID);
    expect(await store.list()).toEqual([]);
  });

  it("skips corrupted json files during load", async () => {
    await fs.mkdir(path.join(workspace, ".tasks", SID), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".tasks", SID, "bogus.json"),
      "{not json",
    );
    const store = new TaskStore(workspace, SID);
    expect(await store.list()).toEqual([]);
  });

  it("isolates tasks between sessions in the same workspace", async () => {
    const sessionA = new TaskStore(workspace, "session-a");
    const sessionB = new TaskStore(workspace, "session-b");
    await sessionA.create("alpha");
    await sessionB.create("beta");

    const aTasks = await sessionA.list();
    const bTasks = await sessionB.list();
    expect(aTasks).toHaveLength(1);
    expect(aTasks[0]?.description).toBe("alpha");
    expect(bTasks).toHaveLength(1);
    expect(bTasks[0]?.description).toBe("beta");
  });

  it("returned task arrays are defensive copies", async () => {
    const store = new TaskStore(workspace, SID);
    const t = await store.create("a");
    t.blockedBy.push("mutated");
    const fresh = await store.get(t.id);
    expect(fresh?.blockedBy).toEqual([]);
  });
});

describe("TaskStore.clear", () => {
  it("with no args clears all tasks and removes the session directory", async () => {
    const store = new TaskStore(workspace, SID);
    await store.create("a");
    await store.create("b");
    await store.clear();
    expect(await store.list()).toEqual([]);
    await expect(fs.access(path.join(workspace, ".tasks", SID))).rejects.toThrow();
  });

  it("with ids deletes only those tasks and their json files", async () => {
    const store = new TaskStore(workspace, SID);
    const a = await store.create("a");
    const b = await store.create("b");
    const c = await store.create("c");
    await store.clear([a.id, b.id, "missing"]);

    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(c.id);

    await expect(
      fs.access(path.join(workspace, ".tasks", SID, `${a.id}.json`)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(workspace, ".tasks", SID, `${c.id}.json`)),
    ).resolves.toBeUndefined();
  });

  it("tolerates clear when no tasks exist", async () => {
    const store = new TaskStore(workspace, SID);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });
});
