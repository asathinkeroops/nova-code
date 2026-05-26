import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { TaskStore } from "./store.js";

const inputSchema = z
  .object({
    id: z.string().min(1).describe("Task id returned by createTask."),
  })
  .strict();

export function getTaskTool(store: TaskStore): ToolHandler {
  return {
    definition: {
      name: "getTask",
      description:
        "Fetch a single task by id. Returns the task JSON " +
        "({ id, description, blockedBy, status }), or an error if no such id exists.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        const task = await store.get(input.id);
        if (!task) {
          return { output: `getTask failed: task not found: ${input.id}`, isError: true };
        }
        return { output: JSON.stringify(task) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `getTask failed: ${msg}`, isError: true };
      }
    },
  };
}
