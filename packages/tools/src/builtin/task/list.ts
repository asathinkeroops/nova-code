import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { TaskStore } from "./store.js";

const STATUSES = ["pending", "in_progress", "completed"] as const;

const inputSchema = z
  .object({
    status: z
      .enum(STATUSES)
      .optional()
      .describe("Filter by status. Omit to return all tasks."),
  })
  .strict();

export function getTaskListTool(store: TaskStore): ToolHandler {
  return {
    definition: {
      name: "getTaskList",
      description:
        "List tasks in the workspace plan. Optionally filter by status. " +
        "Returns a JSON array of { id, description, blockedBy, status }. " +
        "Order is not guaranteed.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        const tasks = await store.list(input.status);
        return { output: JSON.stringify(tasks) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `getTaskList failed: ${msg}`, isError: true };
      }
    },
  };
}
