import { markSynthetic, type MessageParam, type ToolUseBlock } from "@nova/core";
import type { InterjectCtx, InterjectFn } from "../todo/reminder.js";
import { TaskStore } from "./store.js";

export interface TaskReminderOptions {
  threshold?: number;
  toolName?: string;
  reminderText?: string;
}

export function makeTaskReminder(store: TaskStore, opts: TaskReminderOptions = {}): InterjectFn {
  const threshold = opts.threshold ?? 3;
  const toolName = opts.toolName ?? "updateTask";
  const text = opts.reminderText ?? "<task-reminder>Update your tasks.</task-reminder>";
  let streak = 0;

  return async ({ toolUses }: InterjectCtx): Promise<MessageParam[] | void> => {
    const all = await store.list();
    const hasUnfinished = all.some((t) => t.status === "pending" || t.status === "in_progress");

    // A fully-completed plan (non-empty, nothing in flight) no longer nudges a
    // clearTaskList here: the CLI auto-clears it after a short delay
    // (scheduleTaskAutoClear), independent of the model. Such a plan just falls
    // through to the `!hasUnfinished` suppression below.

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
    return [markSynthetic({ role: "user", content: [{ type: "text", text }] }, "task-reminder")];
  };
}
