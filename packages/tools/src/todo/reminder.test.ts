import { describe, expect, it } from "vitest";
import type { ContentBlock, MessageParam, ToolUseBlock } from "@nova/core";
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

/** Extract the concatenated text of a message's content blocks. */
function textOf(msg: MessageParam): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .map((b) => (b.type === "text" ? (b as Extract<ContentBlock, { type: "text" }>).text : ""))
    .join("");
}

describe("makeTodoReminder", () => {
  it("injects listing every open item on a turn that made progress", async () => {
    const store = new TodoStore();
    store.create("write code");
    store.create("fix test");
    const remind = makeTodoReminder(store);

    const out = await call(remind, [use("bash")]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<todo-reminder>Update your todos:\n- [pending] write code\n- [pending] fix test</todo-reminder>",
          },
        ],
        meta: { synthetic: true, kind: "todo-reminder" },
      },
    ]);
  });

  it("lists in_progress items too, next to pending ones", async () => {
    const store = new TodoStore();
    const running = store.create("running");
    store.update(running.id, "in_progress");
    store.create("next");
    const remind = makeTodoReminder(store);

    const out = (await call(remind, [use("bash")]))!;
    expect(textOf(out[0] as MessageParam)).toContain("- [in_progress] running");
    expect(textOf(out[0] as MessageParam)).toContain("- [pending] next");
  });

  it("does not inject on a turn with no tool calls (no progress)", async () => {
    const store = new TodoStore();
    store.create("x");
    const remind = makeTodoReminder(store);

    expect(await call(remind, [])).toBeUndefined();
  });

  it("does not inject when the list is empty", async () => {
    const store = new TodoStore();
    const remind = makeTodoReminder(store);

    expect(await call(remind, [use("bash")])).toBeUndefined();
  });

  it("stays silent when every todo is completed (CLI auto-clears instead of nudging)", async () => {
    const store = new TodoStore();
    const done = store.create("done already");
    store.update(done.id, "completed");
    const remind = makeTodoReminder(store);

    expect(await call(remind, [use("bash")])).toBeUndefined();
  });

  it("only lists pending and in_progress, excluding completed items", async () => {
    const store = new TodoStore();
    store.create("open");
    const done = store.create("closed");
    store.update(done.id, "completed");
    const remind = makeTodoReminder(store);

    const out = (await call(remind, [use("bash")]))!;
    const text = textOf(out[0] as MessageParam);
    expect(text).toContain("- [pending] open");
    expect(text).not.toContain("closed");
  });

  it("honors a custom reminderText head", async () => {
    const store = new TodoStore();
    store.create("x");
    const remind = makeTodoReminder(store, { reminderText: "PLEASE UPDATE:" });

    const out = (await call(remind, [use("bash")]))!;
    expect(textOf(out[0] as MessageParam)).toBe(
      "<todo-reminder>PLEASE UPDATE:\n- [pending] x</todo-reminder>",
    );
  });
});
