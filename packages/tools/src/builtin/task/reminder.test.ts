import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageParam, ToolUseBlock } from "@nova/core";
import { TaskStore } from "./store.js";
import { makeTaskReminder } from "./reminder.js";

function use(name: string, id = name): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}

function call(
  fn: ReturnType<typeof makeTaskReminder>,
  toolUses: ToolUseBlock[],
  turn = 1,
): Promise<MessageParam[] | void> {
  return fn({ turn, toolUses });
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(tmpdir(), "nova-task-reminder-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("makeTaskReminder", () => {
  it("injects after `threshold` consecutive turns without updateTask when tasks are unfinished", async () => {
    const store = new TaskStore(workspace, "test-session");
    await store.create("plan migration");
    const remind = makeTaskReminder(store);

    expect(await call(remind, [use("bash")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeUndefined();
    const out = await call(remind, [use("edit")]);
    expect(out).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "<reminder>Update your tasks.</reminder>" }],
      },
    ]);
  });

  it("resets the streak whenever updateTask appears in the turn", async () => {
    const store = new TaskStore(workspace, "test-session");
    await store.create("x");
    const remind = makeTaskReminder(store);

    await call(remind, [use("bash")]);
    await call(remind, [use("updateTask")]); // reset
    expect(await call(remind, [use("read")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeDefined();
  });

  it("counts a mixed turn (updateTask + other tools) as a reset", async () => {
    const store = new TaskStore(workspace, "test-session");
    await store.create("x");
    const remind = makeTaskReminder(store);

    await call(remind, [use("bash")]);
    await call(remind, [use("updateTask"), use("bash")]); // reset
    expect(await call(remind, [use("read")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeUndefined();
    expect(await call(remind, [use("read")])).toBeDefined();
  });

  it("resets streak after injecting so the next reminder needs another `threshold` turns", async () => {
    const store = new TaskStore(workspace, "test-session");
    await store.create("x");
    const remind = makeTaskReminder(store);

    await call(remind, [use("bash")]);
    await call(remind, [use("bash")]);
    await call(remind, [use("bash")]); // injects
    expect(await call(remind, [use("bash")])).toBeUndefined();
    expect(await call(remind, [use("bash")])).toBeUndefined();
    expect(await call(remind, [use("bash")])).toBeDefined();
  });

  it("does not inject when the task list is empty", async () => {
    const store = new TaskStore(workspace, "test-session");
    const remind = makeTaskReminder(store);

    await call(remind, [use("bash")]);
    await call(remind, [use("bash")]);
    expect(await call(remind, [use("bash")])).toBeUndefined();
  });

  it("nudges clearTaskList immediately when all tasks are completed", async () => {
    const store = new TaskStore(workspace, "test-session");
    const t = await store.create("done already");
    await store.update(t.id, { status: "completed" });
    const remind = makeTaskReminder(store);

    expect(await call(remind, [use("bash")])).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<reminder>All tasks are completed — call clearTaskList to clear the list.</reminder>",
          },
        ],
      },
    ]);
  });

  it("fires the clear nudge even on the turn that completed the last task", async () => {
    const store = new TaskStore(workspace, "test-session");
    const t = await store.create("x");
    await store.update(t.id, { status: "completed" });
    const remind = makeTaskReminder(store);

    const out = await call(remind, [use("updateTask")]);
    expect(out).toBeDefined();
  });

  it("stops nudging once the list is cleared", async () => {
    const store = new TaskStore(workspace, "test-session");
    const t = await store.create("x");
    await store.update(t.id, { status: "completed" });
    const remind = makeTaskReminder(store);

    expect(await call(remind, [use("bash")])).toBeDefined();
    await store.clear();
    expect(await call(remind, [use("bash")])).toBeUndefined();
  });

  it("preserves streak across suppressed turns: a new in_progress task triggers immediately", async () => {
    const store = new TaskStore(workspace, "test-session");
    const remind = makeTaskReminder(store);

    // 3 silent turns while the list is empty — no inject, but streak keeps growing.
    await call(remind, [use("bash")]);
    await call(remind, [use("bash")]);
    expect(await call(remind, [use("bash")])).toBeUndefined();

    // Now add an unfinished task. The very next non-updateTask turn triggers.
    const t = await store.create("new task");
    await store.update(t.id, { status: "in_progress" });
    expect(await call(remind, [use("bash")])).toBeDefined();
  });

  it("honors custom threshold, toolName and reminderText", async () => {
    const store = new TaskStore(workspace, "test-session");
    await store.create("x");
    const remind = makeTaskReminder(store, {
      threshold: 2,
      toolName: "myUpdate",
      reminderText: "PLEASE UPDATE",
    });

    expect(await call(remind, [use("bash")])).toBeUndefined();
    const out = await call(remind, [use("bash")]);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "PLEASE UPDATE" }] },
    ]);

    // myUpdate (not updateTask) is what resets now.
    await call(remind, [use("myUpdate")]);
    expect(await call(remind, [use("bash")])).toBeUndefined();
    expect(await call(remind, [use("bash")])).toBeDefined();
  });
});
