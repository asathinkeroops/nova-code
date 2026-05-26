import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "./store.js";
import {
  createTaskTool,
  getTaskListTool,
  getTaskTool,
  updateTaskTool,
} from "./index.js";

interface TaskResult {
  id: string;
  description: string;
  blockedBy: string[];
  status: string;
}

const ctx = { cwd: process.cwd() };

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(tmpdir(), "nova-task-tools-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function tools() {
  const store = new TaskStore(workspace, "test-session");
  return {
    store,
    create: createTaskTool(store),
    update: updateTaskTool(store),
    get: getTaskTool(store),
    list: getTaskListTool(store),
  };
}

describe("createTask tool", () => {
  it("creates a task and returns it as JSON", async () => {
    const t = tools();
    const res = await t.create.run({ description: "plan the migration" }, ctx);
    expect(res.isError).toBeUndefined();
    const task = JSON.parse(res.output) as TaskResult;
    expect(task.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(task.description).toBe("plan the migration");
    expect(task.blockedBy).toEqual([]);
    expect(task.status).toBe("pending");
  });

  it("rejects empty descriptions at the schema layer", async () => {
    const t = tools();
    await expect(t.create.run({ description: "" }, ctx)).rejects.toThrow();
  });

  it("rejects extra keys (strict schema)", async () => {
    const t = tools();
    await expect(
      t.create.run({ description: "x", blockedBy: ["y"] }, ctx),
    ).rejects.toThrow();
  });
});

describe("updateTask tool", () => {
  it("updates status and returns the new task", async () => {
    const t = tools();
    const created = JSON.parse(
      (await t.create.run({ description: "x" }, ctx)).output,
    ) as TaskResult;
    const res = await t.update.run({ id: created.id, status: "in_progress" }, ctx);
    expect(res.isError).toBeUndefined();
    const task = JSON.parse(res.output) as TaskResult;
    expect(task.status).toBe("in_progress");
  });

  it("applies addBlockedBy and removeBlockedBy patches", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as TaskResult;
    await t.update.run({ id: a.id, addBlockedBy: ["x", "y"] }, ctx);
    const after = JSON.parse(
      (await t.update.run({ id: a.id, removeBlockedBy: ["x"] }, ctx)).output,
    ) as TaskResult;
    expect(after.blockedBy).toEqual(["y"]);
  });

  it("rejects no-op update (isError)", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as TaskResult;
    const res = await t.update.run({ id: a.id }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/at least one/);
  });

  it("rejects self-reference in addBlockedBy (isError)", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as TaskResult;
    const res = await t.update.run({ id: a.id, addBlockedBy: [a.id] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/self/);
  });

  it("rejects add/remove overlap (isError)", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as TaskResult;
    const res = await t.update.run(
      { id: a.id, addBlockedBy: ["x"], removeBlockedBy: ["x"] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/overlap/);
  });

  it("rejects unknown id (isError)", async () => {
    const t = tools();
    const res = await t.update.run({ id: "missing", status: "completed" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/not found/);
  });

  it("rejects description field (strict schema, immutable)", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as TaskResult;
    await expect(
      t.update.run({ id: a.id, description: "tampered" }, ctx),
    ).rejects.toThrow();
  });

  it("rejects invalid status transitions (isError)", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as TaskResult;
    await t.update.run({ id: a.id, status: "completed" }, ctx);
    const res = await t.update.run({ id: a.id, status: "in_progress" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/invalid transition/);
  });
});

describe("getTask tool", () => {
  it("returns the task by id", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as TaskResult;
    const res = await t.get.run({ id: a.id }, ctx);
    expect(res.isError).toBeUndefined();
    const task = JSON.parse(res.output) as TaskResult;
    expect(task.id).toBe(a.id);
  });

  it("returns isError when id is unknown", async () => {
    const t = tools();
    const res = await t.get.run({ id: "missing" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/not found/);
  });
});

describe("getTaskList tool", () => {
  it("returns all tasks when no filter", async () => {
    const t = tools();
    await t.create.run({ description: "a" }, ctx);
    await t.create.run({ description: "b" }, ctx);
    const res = await t.list.run({}, ctx);
    const tasks = JSON.parse(res.output) as TaskResult[];
    expect(tasks).toHaveLength(2);
  });

  it("filters by status", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as TaskResult;
    await t.create.run({ description: "b" }, ctx);
    await t.update.run({ id: a.id, status: "in_progress" }, ctx);
    const inProg = JSON.parse(
      (await t.list.run({ status: "in_progress" }, ctx)).output,
    ) as TaskResult[];
    expect(inProg).toHaveLength(1);
    expect(inProg[0]?.id).toBe(a.id);
  });

  it("rejects unknown status values", async () => {
    const t = tools();
    await expect(t.list.run({ status: "bogus" }, ctx)).rejects.toThrow();
  });
});
