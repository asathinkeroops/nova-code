import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { TodoStore } from "@nova/orchestration";

const STATUSES = ["pending", "in_progress", "completed", "error"] as const;

const inputSchema = z
  .object({
    status: z
      .enum(STATUSES)
      .optional()
      .describe("Filter by status. Omit to return all todos."),
  })
  .strict();

export function getTodosTool(store: TodoStore): ToolHandler {
  return {
    definition: {
      name: "getTodos",
      description:
        "List the current session's todos in creation order. Optionally filter by status. " +
        "Todos are kept in memory only and reset when the process exits. " +
        "Returns a JSON array of { id, description, status }.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      const todos = store.list(input.status);
      return { output: JSON.stringify(todos) };
    },
  };
}
