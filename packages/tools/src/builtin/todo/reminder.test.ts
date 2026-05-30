import { describe, expect, it } from "vitest";
import type { MessageParam, ToolUseBlock } from "@nova/core";
import { TodoStore } from "./store.js";
import { makeTodoReminder } from "./reminder.js";

function use(name: string, id = name): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}

function call(
  fn: ReturnType<typeof makeTodoReminder>,
  toolUses: ToolUseBlock[],
  turn = 1,
): Promise<MessageParam[] | void> {
  return fn({ turn, toolUses });
}

describe("makeTodoReminder", () => {
  it("injects after `threshold` consecutive turns without updateTodo when todos are unfinished", async () => {
    const store = new TodoStore();
    store.create("write code");
    const remind = makeTodoReminder(store);

    expect(await call(remind, [use("bash")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeUndefined();
    const out = await call(remind, [use("edit")]);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "<reminder>Update your todos.</reminder>" }] },
    ]);
  });

  it("resets the streak whenever updateTodo appears in the turn", async () => {
    const store = new TodoStore();
    store.create("x");
    const remind = makeTodoReminder(store);

    await call(remind, [use("bash")]);
    await call(remind, [use("updateTodo")]); // reset
    expect(await call(remind, [use("read")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeDefined();
  });

  it("counts a mixed turn (updateTodo + other tools) as a reset", async () => {
    const store = new TodoStore();
    store.create("x");
    const remind = makeTodoReminder(store);

    await call(remind, [use("bash")]);
    await call(remind, [use("updateTodo"), use("bash")]); // reset
    expect(await call(remind, [use("read")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeDefined();
  });

  it("resets streak after injecting so the next reminder needs another `threshold` turns", async () => {
    const store = new TodoStore();
    store.create("x");
    const remind = makeTodoReminder(store);

    await call(remind, [use("bash")]);
    await call(remind, [use("bash")]);
    await call(remind, [use("bash")]); // injects
    expect(await call(remind, [use("bash")])).toBeUndefined();
    expect(await call(remind, [use("bash")])).toBeUndefined();
    expect(await call(remind, [use("bash")])).toBeDefined();
  });

  it("does not inject when the todo list is empty", async () => {
    const store = new TodoStore();
    const remind = makeTodoReminder(store);

    await call(remind, [use("bash")]);
    await call(remind, [use("bash")]);
    expect(await call(remind, [use("bash")])).toBeUndefined();
  });

  it("nudges clearTodoList immediately when all todos are completed", async () => {
    const store = new TodoStore();
    const t = store.create("done already");
    store.update(t.id, "completed");
    const remind = makeTodoReminder(store);

    // No streak buildup needed: a fully-completed list nudges a clear at once.
    expect(await call(remind, [use("bash")])).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<reminder>All todos are completed — call clearTodoList to clear the list.</reminder>",
          },
        ],
      },
    ]);
  });

  it("fires the clear nudge even on the turn that completed the last todo", async () => {
    const store = new TodoStore();
    const t = store.create("x");
    store.update(t.id, "completed");
    const remind = makeTodoReminder(store);

    // updateTodo in the turn would normally reset/suppress — the clear nudge wins.
    const out = await call(remind, [use("updateTodo")]);
    expect(out).toBeDefined();
  });

  it("stops nudging once the list is cleared", async () => {
    const store = new TodoStore();
    const t = store.create("x");
    store.update(t.id, "completed");
    const remind = makeTodoReminder(store);

    expect(await call(remind, [use("bash")])).toBeDefined();
    store.clear();
    expect(await call(remind, [use("bash")])).toBeUndefined();
  });

  it("preserves streak across suppressed turns: a new in_progress todo triggers immediately", async () => {
    const store = new TodoStore();
    const remind = makeTodoReminder(store);

    // 3 silent turns while the list is empty — no inject, but streak keeps growing.
    await call(remind, [use("bash")]);
    await call(remind, [use("bash")]);
    expect(await call(remind, [use("bash")])).toBeUndefined();

    // Now add an unfinished todo. The very next non-updateTodo turn triggers.
    const t = store.create("new task");
    store.update(t.id, "in_progress");
    expect(await call(remind, [use("bash")])).toBeDefined();
  });

  it("honors custom threshold, toolName and reminderText", async () => {
    const store = new TodoStore();
    store.create("x");
    const remind = makeTodoReminder(store, {
      threshold: 2,
      toolName: "myUpdate",
      reminderText: "PLEASE UPDATE",
    });

    expect(await call(remind, [use("bash")])).toBeUndefined();
    const out = await call(remind, [use("bash")]);
    expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "PLEASE UPDATE" }] }]);

    // myUpdate (not updateTodo) is what resets now.
    await call(remind, [use("myUpdate")]);
    expect(await call(remind, [use("bash")])).toBeUndefined();
    expect(await call(remind, [use("bash")])).toBeDefined();
  });
});
