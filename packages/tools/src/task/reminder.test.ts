import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentBlock, MessageParam, ToolUseBlock } from "@nova/core";
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

/** Extract the concatenated text of a message's content blocks. */
function textOf(msg: MessageParam): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .map((b) => (b.type === "text" ? (b as Extract<ContentBlock, { type: "text" }>).text : ""))
    .join("");
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(tmpdir(), "nova-task-reminder-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("makeTaskReminder", () => {
  it("injects listing every open task on a turn that made progress", async () => {
    const store = new TaskStore(workspace, "test-session");
    await store.create("plan migration");
    await store.create("write docs");
    const remind = makeTaskReminder(store);

    const out = await call(remind, [use("bash")]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<task-reminder>Update your tasks:\n- [pending] plan migration\n- [pending] write docs</task-reminder>",
          },
        ],
        meta: { synthetic: true, kind: "task-reminder" },
      },
    ]);
  });

  it("lists in_progress items too, next to pending ones", async () => {
    const store = new TaskStore(workspace, "test-session");
    const running = await store.create("running");
    await store.update(running.id, { status: "in_progress" });
    await store.create("next");
    const remind = makeTaskReminder(store);

    const out = (await call(remind, [use("bash")]))!;
    expect(textOf(out[0] as MessageParam)).toContain("- [in_progress] running");
    expect(textOf(out[0] as MessageParam)).toContain("- [pending] next");
  });

  it("does not inject on a turn with no tool calls (no progress)", async () => {
    const store = new TaskStore(workspace, "test-session");
    await store.create("x");
    const remind = makeTaskReminder(store);

    expect(await call(remind, [])).toBeUndefined();
  });

  it("does not inject when the task list is empty", async () => {
    const store = new TaskStore(workspace, "test-session");
    const remind = makeTaskReminder(store);

    expect(await call(remind, [use("bash")])).toBeUndefined();
  });

  it("stays silent when every task is completed (CLI auto-clears instead of nudging)", async () => {
    const store = new TaskStore(workspace, "test-session");
    const done = await store.create("done already");
    await store.update(done.id, { status: "completed" });
    const remind = makeTaskReminder(store);

    expect(await call(remind, [use("bash")])).toBeUndefined();
  });

  it("only lists pending and in_progress, excluding completed items", async () => {
    const store = new TaskStore(workspace, "test-session");
    await store.create("open");
    const done = await store.create("closed");
    await store.update(done.id, { status: "completed" });
    const remind = makeTaskReminder(store);

    const out = (await call(remind, [use("bash")]))!;
    const text = textOf(out[0] as MessageParam);
    expect(text).toContain("- [pending] open");
    expect(text).not.toContain("closed");
  });

  it("honors a custom reminderText head", async () => {
    const store = new TaskStore(workspace, "test-session");
    await store.create("x");
    const remind = makeTaskReminder(store, { reminderText: "PLEASE UPDATE:" });

    const out = (await call(remind, [use("bash")]))!;
    expect(textOf(out[0] as MessageParam)).toBe(
      "<task-reminder>PLEASE UPDATE:\n- [pending] x</task-reminder>",
    );
  });
});
