import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { TodoStore } from "./store.js";

const STATUSES = ["pending", "in_progress", "completed"] as const;

const inputSchema = z
  .object({
    id: z.string().min(1).describe("Todo id returned by createTodo."),
    status: z
      .enum(STATUSES)
      .describe(
        "New status. Only one todo may be in_progress at a time; " +
          "move it back to 'pending' to pause.",
      ),
  })
  .strict();

export function updateTodoTool(store: TodoStore): ToolHandler {
  return {
    definition: {
      name: "updateTodo",
      description:
        "Update a todo's status. Only status is mutable — description cannot be changed. " +
        "Allowed transitions: pending↔in_progress, → completed, completed → pending (retry). " +
        "Invariant: at most one todo can be in_progress at any time; violating updates are rejected " +
        "(finish or pause the current in_progress one first).",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        const todo = store.update(input.id, input.status);
        return { output: JSON.stringify(todo) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `updateTodo failed: ${msg}`, isError: true };
      }
    },
  };
}
