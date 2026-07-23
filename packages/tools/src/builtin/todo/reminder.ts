import { markSynthetic, type MessageParam, type ToolUseBlock } from "@nova/core";
import { TodoStore } from "./store.js";

export interface TodoReminderOptions {
  threshold?: number;
  toolName?: string;
  reminderText?: string;
}

export type InterjectCtx = { turn: number; toolUses: ToolUseBlock[] };
export type InterjectFn = (ctx: InterjectCtx) => Promise<MessageParam[] | void>;

export function makeTodoReminder(store: TodoStore, opts: TodoReminderOptions = {}): InterjectFn {
  const threshold = opts.threshold ?? 3;
  const toolName = opts.toolName ?? "updateTodo";
  const text = opts.reminderText ?? "<todo-reminder>Update your todos.</todo-reminder>";
  let streak = 0;

  return async ({ toolUses }) => {
    const list = store.list();
    const hasUnfinished = list.some((t) => t.status === "pending" || t.status === "in_progress");

    // A fully-completed list (non-empty, nothing in flight) no longer nudges a
    // clearTodoList here: the CLI auto-clears it after a short delay
    // (scheduleTodoAutoClear), which doesn't depend on the model complying. Such
    // a list just falls through to the `!hasUnfinished` suppression below.

    if (toolUses.some((u) => u.name === toolName)) {
      streak = 0;
      return;
    }
    streak++;
    if (streak < threshold) return;

    // Suppress when nothing is actionable (empty list). Keep streak so a fresh
    // in_progress todo can trigger immediately on the next turn instead of
    // waiting another `threshold` turns.
    if (!hasUnfinished) return;

    streak = 0;
    return [markSynthetic({ role: "user", content: [{ type: "text", text }] }, "todo-reminder")];
  };
}
