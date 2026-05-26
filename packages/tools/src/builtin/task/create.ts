import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { TaskStore } from "./store.js";

const inputSchema = z
  .object({
    description: z
      .string()
      .min(1)
      .describe("What this task represents. Immutable once created."),
  })
  .strict();

export function createTaskTool(store: TaskStore): ToolHandler {
  return {
    definition: {
      name: "createTask",
      description:
        "Create a new task (status=pending, blockedBy=[]) in the workspace's plan. " +
        "Tasks persist to `.tasks/{id}.json` in the workspace and survive across sessions. " +
        "Returns the new task as JSON. description is immutable; status and blockedBy " +
        "are mutated via updateTask. blockedBy always starts empty — add dependencies later " +
        "with updateTask({ addBlockedBy: [...] }).",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        const task = await store.create(input.description);
        return { output: JSON.stringify(task) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `createTask failed: ${msg}`, isError: true };
      }
    },
  };
}
