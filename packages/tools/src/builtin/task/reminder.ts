import type { MessageParam, ToolUseBlock } from "@nova/core";
import type { InterjectCtx, InterjectFn } from "../todo/reminder.js";
import { TaskStore } from "./store.js";

export interface TaskReminderOptions {
  threshold?: number;
  toolName?: string;
  reminderText?: string;
  /** Sent when every task is finished, nudging a clearTaskList. */
  clearReminderText?: string;
}

export function makeTaskReminder(
  store: TaskStore,
  opts: TaskReminderOptions = {},
): InterjectFn {
  const threshold = opts.threshold ?? 3;
  const toolName = opts.toolName ?? "updateTask";
  const text = opts.reminderText ?? "<reminder>Update your tasks.</reminder>";
  const clearText =
    opts.clearReminderText ??
    "<reminder>All tasks are completed — call clearTaskList to clear the list.</reminder>";
  let streak = 0;

  return async ({ toolUses }: InterjectCtx): Promise<MessageParam[] | void> => {
    const all = await store.list();
    const hasUnfinished = all.some(
      (t) => t.status === "pending" || t.status === "in_progress",
    );

    // Plan is done (non-empty, nothing in flight) — exactly when clearTaskList
    // should fire, and exactly when the streak logic below used to stay silent
    // and leave stale tasks behind. Nudge a clear right away, independent of
    // streak or whether this turn called updateTask.
    if (all.length > 0 && !hasUnfinished) {
      streak = 0;
      return [{ role: "user", content: [{ type: "text", text: clearText }] }];
    }

    if (toolUses.some((u: ToolUseBlock) => u.name === toolName)) {
      streak = 0;
      return;
    }
    streak++;
    if (streak < threshold) return;

    // Suppress when nothing is actionable (empty list). Keep streak so a fresh
    // in_progress task can trigger immediately on the next turn instead of
    // waiting another `threshold` turns.
    if (!hasUnfinished) return;

    streak = 0;
    return [{ role: "user", content: [{ type: "text", text }] }];
  };
}
