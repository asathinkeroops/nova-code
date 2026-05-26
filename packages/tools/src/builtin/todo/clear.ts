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
        "MUST be called to wipe the todo list when ANY of these conditions hold:\n" +
        "1. Every todo currently in `getTodoList` has status=completed — the checklist is done, " +
        "clear it so the next user prompt starts fresh.\n" +
        "2. The user's new request is unrelated to the current todo list (e.g. they switched " +
        "topics, asked a fresh question, or said \"forget that\" / \"start over\").\n" +
        "3. You are about to call `createTodo` for a brand-new checklist and the existing todos " +
        "would be irrelevant clutter — clear first, then create.\n" +
        "\n" +
        "Todos persist across turns and never auto-clear; if you skip this tool, stale todos " +
        "stay visible to the user forever. When in doubt at the end of a finished checklist, CLEAR.\n" +
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
