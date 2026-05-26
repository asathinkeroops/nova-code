import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { TodoStore } from "./store.js";

const inputSchema = z
  .object({
    description: z
      .string()
      .min(1)
      .describe("What this todo represents. Immutable once created."),
  })
  .strict();

export function createTodoTool(store: TodoStore): ToolHandler {
  return {
    definition: {
      name: "createTodo",
      description:
        "Append a new todo (status=pending) to the current session's checklist. " +
        "Use to externalize a multi-step plan so it survives context shifts within this session. " +
        "Returns the generated id; the description is immutable after creation. " +
        "Todos are in-memory only — they do not persist across sessions. " +
        "For cross-session work tracking, use the Task Store instead.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        const todo = store.create(input.description);
        return { output: JSON.stringify(todo) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `createTodo failed: ${msg}`, isError: true };
      }
    },
  };
}
