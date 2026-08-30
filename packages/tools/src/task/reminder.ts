import { markSynthetic, type MessageParam } from "@nova/core";
import type { InterjectCtx, InterjectFn } from "../todo/reminder.js";
import { TaskStore } from "./store.js";

export interface TaskReminderOptions {
  /** Head line before the bulleted open items. Default: "Update your tasks:". */
  reminderText?: string;
}

export function makeTaskReminder(store: TaskStore, opts: TaskReminderOptions = {}): InterjectFn {
  const head = opts.reminderText ?? "Update your tasks:";

  return async ({ toolUses }: InterjectCtx): Promise<MessageParam[] | void> => {
    // Only nudge on a turn that actually moved the plan forward. The loop pairs
    // every tool_use with a tool_result, so a non-empty set here IS the progress.
    if (toolUses.length === 0) return undefined;

    const all = await store.list();
    const open = all.filter((t) => t.status === "pending" || t.status === "in_progress");
    if (open.length === 0) return undefined;

    // List the specific open items so the model can act on them directly rather
    // than a vague "update your tasks" it may not map back to the plan.
    const lines = open.map((t) => `- [${t.status}] ${t.description}`);
    const text = `<task-reminder>${head}\n${lines.join("\n")}</task-reminder>`;
    return [markSynthetic({ role: "user", content: [{ type: "text", text }] }, "task-reminder")];
  };
}
