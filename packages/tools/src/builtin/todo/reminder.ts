import type { MessageParam, ToolUseBlock } from "@nova/core";
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
  const text = opts.reminderText ?? "<reminder>Update your todos.</reminder>";
  let streak = 0;

  return async ({ toolUses }) => {
    if (toolUses.some((u) => u.name === toolName)) {
      streak = 0;
      return;
    }
    streak++;
    if (streak < threshold) return;

    // Suppress when nothing is actionable. Keep streak so a fresh in_progress
    // todo can trigger immediately on the next turn instead of waiting another
    // `threshold` turns.
    const hasUnfinished = store
      .list()
      .some((t) => t.status === "pending" || t.status === "in_progress");
    if (!hasUnfinished) return;

    streak = 0;
    return [{ role: "user", content: [{ type: "text", text }] }];
  };
}
