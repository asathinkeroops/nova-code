import type { MessageParam, ToolUseBlock } from "@nova/core";
import type { InterjectCtx, InterjectFn } from "../todo/reminder.js";
import { TaskStore } from "./store.js";

export interface TaskReminderOptions {
  threshold?: number;
  toolName?: string;
  reminderText?: string;
}

export function makeTaskReminder(
  store: TaskStore,
  opts: TaskReminderOptions = {},
): InterjectFn {
  const threshold = opts.threshold ?? 3;
  const toolName = opts.toolName ?? "updateTask";
  const text = opts.reminderText ?? "<reminder>Update your tasks.</reminder>";
  let streak = 0;

  return async ({ toolUses }: InterjectCtx): Promise<MessageParam[] | void> => {
    if (toolUses.some((u: ToolUseBlock) => u.name === toolName)) {
      streak = 0;
      return;
    }
    streak++;
    if (streak < threshold) return;

    // Suppress when nothing is actionable. Keep streak so a fresh in_progress
    // task can trigger immediately on the next turn instead of waiting another
    // `threshold` turns.
    const all = await store.list();
    const hasUnfinished = all.some(
      (t) => t.status === "pending" || t.status === "in_progress",
    );
    if (!hasUnfinished) return;

    streak = 0;
    return [{ role: "user", content: [{ type: "text", text }] }];
  };
}
