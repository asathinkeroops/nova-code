import type { ToolHandler, ToolPromptSection } from "@nova/core";
import { TodoStore } from "./store.js";
import { clearTodoListTool } from "./clear.js";
import { createTodoTool } from "./create.js";
import { getTodoListTool } from "./list.js";
import { updateTodoTool } from "./update.js";
import { presentList } from "../prompt.js";

export { clearTodoListTool, createTodoTool, getTodoListTool, updateTodoTool };

const TODO_TOOL_NAMES = ["createTodo", "updateTodo", "getTodoList", "clearTodoList"] as const;

/** How to use the checklist, and when not to bother. */
export const TODO_PROMPT: ToolPromptSection = {
  id: "todo",
  order: 10,
  // The two the discipline hinges on; the render only names what is present, so
  // a denylist that removes one of the others doesn't advertise it.
  requires: ["createTodo", "updateTodo"],
  render: (ctx) =>
    `- For non-trivial work spanning several steps, track a short checklist with ${presentList(ctx, TODO_TOOL_NAMES)} — mark an item in_progress when you start it, completed when it's done. Skip this for single-step or trivial requests; just do them directly.`,
};

export function createTodoTools(store: TodoStore = new TodoStore()): ToolHandler[] {
  return [
    createTodoTool(store),
    updateTodoTool(store),
    getTodoListTool(store),
    clearTodoListTool(store),
  ];
}
