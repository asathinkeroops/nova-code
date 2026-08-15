import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { TodoStore } from "./store.js";

const inputSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Optional list of todo ids to clear. Omit to clear ALL todos. " +
          "Empty array is rejected to avoid silent no-ops; pass undefined for clear-all.",
      ),
  })
  .strict();

export function clearTodoListTool(store: TodoStore): ToolHandler {
  return {
    definition: {
      name: "clearTodoList",
      description:
        "Wipe the todo list. Call it when EITHER condition holds:\n" +
        "1. The user's new request is unrelated to the current todo list (e.g. they switched " +
        "topics, asked a fresh question, or said \"forget that\" / \"start over\").\n" +
        "2. You are about to call `createTodo` for a brand-new checklist and the existing todos " +
        "would be irrelevant clutter — clear first, then create.\n" +
        "\n" +
        "You do NOT need to call this just because every todo is completed: a fully-completed " +
        "checklist auto-clears shortly on its own. Use this tool for the topic-switch / start-fresh " +
        "cases above, where clearing should not wait.\n" +
        "\n" +
        "Args: omit `ids` to wipe all (the common case). Pass `ids: [...]` only to remove " +
        "specific entries while keeping the rest.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        if (input.ids !== undefined && input.ids.length === 0) {
          return {
            output: "clearTodoList failed: ids is empty; omit `ids` to clear all",
            isError: true,
          };
        }
        const before = store.list().length;
        store.clear(input.ids);
        const after = store.list().length;
        return {
          output: JSON.stringify({ cleared: before - after, remaining: after }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `clearTodoList failed: ${msg}`, isError: true };
      }
    },
  };
}
