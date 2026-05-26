import { describe, expect, it } from "vitest";
import { TodoError, TodoStore, type TodoStatus } from "./store.js";

describe("TodoStore", () => {
  it("creates todos with generated ids and pending status", () => {
    const store = new TodoStore();
    const a = store.create("draft RFC");
    expect(a.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.description).toBe("draft RFC");
    expect(a.status).toBe("pending");
    expect(store.size()).toBe(1);
  });

  it("rejects empty/whitespace descriptions", () => {
    const store = new TodoStore();
    expect(() => store.create("")).toThrow(TodoError);
    expect(() => store.create("   ")).toThrow(TodoError);
  });

  it("returns immutable snapshots (caller mutation does not leak)", () => {
    const store = new TodoStore();
    const t = store.create("x");
    t.description = "tampered";
    t.status = "completed";
    const fresh = store.get(t.id);
    expect(fresh?.description).toBe("x");
    expect(fresh?.status).toBe("pending");
  });

  it("generates unique ids across many creates", () => {
    const store = new TodoStore();
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      ids.add(store.create(`t${i}`).id);
    }
    expect(ids.size).toBe(500);
  });

  describe("status transitions", () => {
    it("allows pending -> in_progress -> completed", () => {
      const store = new TodoStore();
      const t = store.create("task");
      expect(store.update(t.id, "in_progress").status).toBe("in_progress");
      expect(store.update(t.id, "completed").status).toBe("completed");
    });

    it("allows completed -> pending (reopen)", () => {
      const store = new TodoStore();
      const t = store.create("task");
      store.update(t.id, "completed");
      expect(store.update(t.id, "pending").status).toBe("pending");
    });

    it("rejects self-transitions (e.g. pending -> pending)", () => {
      const store = new TodoStore();
      const t = store.create("task");
      expect(() => store.update(t.id, "pending")).toThrow(TodoError);
    });

    it("rejects updates to unknown ids", () => {
      const store = new TodoStore();
      expect(() => store.update("nope", "in_progress")).toThrow(/todo not found/);
    });
  });

  describe("single-in_progress invariant", () => {
    it("rejects setting a second todo to in_progress", () => {
      const store = new TodoStore();
      const a = store.create("a");
      const b = store.create("b");
      store.update(a.id, "in_progress");
      expect(() => store.update(b.id, "in_progress")).toThrow(/already in_progress/);
      // a still in_progress, b still pending
      expect(store.get(a.id)?.status).toBe("in_progress");
      expect(store.get(b.id)?.status).toBe("pending");
    });

    it("allows starting another after the first is moved off in_progress", () => {
      const store = new TodoStore();
      const a = store.create("a");
      const b = store.create("b");
      store.update(a.id, "in_progress");
      store.update(a.id, "completed");
      expect(store.update(b.id, "in_progress").status).toBe("in_progress");
    });
  });

  describe("list / filter", () => {
    it("returns all todos when no filter is given", () => {
      const store = new TodoStore();
      store.create("a");
      store.create("b");
      expect(store.list()).toHaveLength(2);
    });

    it("filters by status", () => {
      const store = new TodoStore();
      const a = store.create("a");
      store.create("b");
      store.update(a.id, "in_progress");
      const inProg = store.list("in_progress");
      expect(inProg).toHaveLength(1);
      expect(inProg[0]?.id).toBe(a.id);
      const pending = store.list("pending");
      expect(pending).toHaveLength(1);
    });

    it("returns empty array for statuses with no matches", () => {
      const store = new TodoStore();
      store.create("a");
      const completed: TodoStatus = "completed";
      expect(store.list(completed)).toEqual([]);
    });
  });

  describe("clear", () => {
    it("with no args clears all todos", () => {
      const store = new TodoStore();
      store.create("a");
      store.create("b");
      store.clear();
      expect(store.list()).toEqual([]);
    });

    it("with ids removes only those todos (missing ids silently ignored)", () => {
      const store = new TodoStore();
      const a = store.create("a");
      const b = store.create("b");
      store.create("c");
      store.clear([a.id, b.id, "missing"]);
      const remaining = store.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.description).toBe("c");
    });
  });
});
