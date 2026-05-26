import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { TaskStore, TaskUpdatePatch } from "./store.js";

const STATUSES = ["pending", "in_progress", "completed"] as const;

const inputSchema = z
  .object({
    id: z.string().min(1).describe("Task id returned by createTask."),
    status: z
      .enum(STATUSES)
      .optional()
      .describe(
        "New status. Allowed transitions: " +
          "pending → in_progress|completed, " +
          "in_progress → completed|pending, " +
          "completed → pending. " +
          "Multiple tasks may be in_progress concurrently.",
      ),
    addBlockedBy: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Task ids to add to blockedBy. Adding an id already present is a no-op. " +
          "Must not contain the task's own id, and must not overlap with removeBlockedBy.",
      ),
    removeBlockedBy: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Task ids to remove from blockedBy. Removing an id not present is a no-op. " +
          "Must not overlap with addBlockedBy.",
      ),
  })
  .strict();

export function updateTaskTool(store: TaskStore): ToolHandler {
  return {
    definition: {
      name: "updateTask",
      description:
        "Update a task's status and/or its blockedBy dependency list. " +
        "At least one of status/addBlockedBy/removeBlockedBy must be provided. " +
        "description is immutable. Changes persist to `.tasks/{id}.json`.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      const patch: TaskUpdatePatch = {};
      if (input.status !== undefined) patch.status = input.status;
      if (input.addBlockedBy !== undefined) patch.addBlockedBy = input.addBlockedBy;
      if (input.removeBlockedBy !== undefined) patch.removeBlockedBy = input.removeBlockedBy;
      try {
        const task = await store.update(input.id, patch);
        return { output: JSON.stringify(task) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `updateTask failed: ${msg}`, isError: true };
      }
    },
  };
}
