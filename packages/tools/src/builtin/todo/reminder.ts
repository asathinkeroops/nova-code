import type { MessageParam, ToolUseBlock } from "@nova/core";
import { TodoStore } from "./store.js";

export interface TodoReminderOptions {
  threshold?: number;
  toolName?: string;
  reminderText?: string;
  /** Sent when every todo is finished, nudging a clearTodoList. */
  clearReminderText?: string;
}

export type InterjectCtx = { turn: number; toolUses: ToolUseBlock[] };
export type InterjectFn = (ctx: InterjectCtx) => Promise<MessageParam[] | void>;

export function makeTodoReminder(store: TodoStore, opts: TodoReminderOptions = {}): InterjectFn {
  const threshold = opts.threshold ?? 3;
  const toolName = opts.toolName ?? "updateTodo";
  const text = opts.reminderText ?? "<reminder>Update your todos.</reminder>";
  const clearText =
    opts.clearReminderText ??
    "<reminder>All todos are completed — call clearTodoList to clear the list.</reminder>";
  let streak = 0;

  return async ({ toolUses }) => {
    const list = store.list();
    const hasUnfinished = list.some(
      (t) => t.status === "pending" || t.status === "in_progress",
    );

    // The list is done (non-empty, nothing left in flight) — this is exactly the
    // moment clearTodoList should fire, and the moment the streak logic below
    // used to go silent, leaving stale todos on screen forever. Nudge a clear
    // immediately, regardless of streak or whether this turn touched updateTodo.
    if (list.length > 0 && !hasUnfinished) {
      streak = 0;
      return [{ role: "user", content: [{ type: "text", text: clearText }] }];
    }

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
    return [{ role: "user", content: [{ type: "text", text }] }];
  };
}
