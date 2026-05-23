import { describe, expect, it } from "vitest";
import { TodoStore } from "@nova/orchestration";
import { createTodoTool, getTodosTool, updateTodoTool } from "./index.js";

interface CreateResult {
  id: string;
  description: string;
  status: string;
}

const ctx = { cwd: process.cwd() };

function tools() {
  const store = new TodoStore();
  return {
    store,
    create: createTodoTool(store),
    update: updateTodoTool(store),
    get: getTodosTool(store),
  };
}

describe("createTodo tool", () => {
  it("creates a todo and returns id/description/status", async () => {
    const t = tools();
    const res = await t.create.run({ description: "write tests" }, ctx);
    expect(res.isError).toBeUndefined();
    const todo = JSON.parse(res.output) as CreateResult;
    expect(todo.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(todo.description).toBe("write tests");
    expect(todo.status).toBe("pending");
  });

  it("rejects empty descriptions at the schema layer", async () => {
    const t = tools();
    await expect(t.create.run({ description: "" }, ctx)).rejects.toThrow();
  });

  it("rejects extra keys (strict schema)", async () => {
    const t = tools();
    await expect(
      t.create.run({ description: "x", status: "completed" }, ctx),
    ).rejects.toThrow();
  });
});

describe("updateTodo tool", () => {
  it("updates status and returns the new todo", async () => {
    const t = tools();
    const created = JSON.parse(
      (await t.create.run({ description: "x" }, ctx)).output,
    ) as CreateResult;
    const res = await t.update.run({ id: created.id, status: "in_progress" }, ctx);
    expect(res.isError).toBeUndefined();
    const todo = JSON.parse(res.output) as CreateResult;
    expect(todo.status).toBe("in_progress");
    expect(todo.description).toBe("x");
  });

  it("rejects description in payload (description immutable)", async () => {
    const t = tools();
    const created = JSON.parse(
      (await t.create.run({ description: "x" }, ctx)).output,
    ) as CreateResult;
    await expect(
      t.update.run(
        { id: created.id, status: "completed", description: "tampered" },
        ctx,
      ),
    ).rejects.toThrow();
  });

  it("reports invariant violation as isError, not a thrown exception", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as CreateResult;
    const b = JSON.parse(
      (await t.create.run({ description: "b" }, ctx)).output,
    ) as CreateResult;
    await t.update.run({ id: a.id, status: "in_progress" }, ctx);
    const res = await t.update.run({ id: b.id, status: "in_progress" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/already in_progress/);
  });

  it("allows error -> pending (retry)", async () => {
    const t = tools();
    const created = JSON.parse(
      (await t.create.run({ description: "x" }, ctx)).output,
    ) as CreateResult;
    await t.update.run({ id: created.id, status: "error" }, ctx);
    const res = await t.update.run({ id: created.id, status: "pending" }, ctx);
    expect(res.isError).toBeUndefined();
    const todo = JSON.parse(res.output) as CreateResult;
    expect(todo.status).toBe("pending");
  });

  it("returns isError when id is unknown", async () => {
    const t = tools();
    const res = await t.update.run({ id: "missing", status: "completed" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/not found/);
  });
});

describe("getTodos tool", () => {
  it("returns all todos when no filter", async () => {
    const t = tools();
    await t.create.run({ description: "a" }, ctx);
    await t.create.run({ description: "b" }, ctx);
    const res = await t.get.run({}, ctx);
    const todos = JSON.parse(res.output) as CreateResult[];
    expect(todos).toHaveLength(2);
    expect(todos.map((x) => x.description)).toEqual(["a", "b"]);
  });

  it("filters by status", async () => {
    const t = tools();
    const a = JSON.parse(
      (await t.create.run({ description: "a" }, ctx)).output,
    ) as CreateResult;
    await t.create.run({ description: "b" }, ctx);
    await t.update.run({ id: a.id, status: "in_progress" }, ctx);
    const inProg = JSON.parse(
      (await t.get.run({ status: "in_progress" }, ctx)).output,
    ) as CreateResult[];
    expect(inProg).toHaveLength(1);
    expect(inProg[0]?.id).toBe(a.id);
  });

  it("rejects unknown status values", async () => {
    const t = tools();
    await expect(t.get.run({ status: "bogus" }, ctx)).rejects.toThrow();
  });
});
