import { markSynthetic, type MessageParam, type ToolUseBlock } from "@nova/core";
import { TodoStore } from "./store.js";

export interface TodoReminderOptions {
  /** Head line before the bulleted open items. Default: "Update your todos:". */
  reminderText?: string;
}

export type InterjectCtx = { turn: number; toolUses: ToolUseBlock[] };
export type InterjectFn = (ctx: InterjectCtx) => Promise<MessageParam[] | void>;

export function makeTodoReminder(store: TodoStore, opts: TodoReminderOptions = {}): InterjectFn {
  const head = opts.reminderText ?? "Update your todos:";

  return async ({ toolUses }: InterjectCtx): Promise<MessageParam[] | void> => {
    // Only nudge on a turn that actually moved the task forward. The loop pairs
    // every tool_use with a tool_result, so a non-empty set here IS the progress.
    if (toolUses.length === 0) return undefined;

    const open = store.list().filter((t) => t.status === "pending" || t.status === "in_progress");
    if (open.length === 0) return undefined;

    // List the specific open items so the model can act on them directly rather
    // than a vague "update your todos" it may not map back to the checklist.
    const lines = open.map((t) => `- [${t.status}] ${t.description}`);
    const text = `<todo-reminder>${head}\n${lines.join("\n")}</todo-reminder>`;
    return [markSynthetic({ role: "user", content: [{ type: "text", text }] }, "todo-reminder")];
  };
}
