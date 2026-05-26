import type { ToolHandler } from "@nova/core";
import { TodoStore } from "./store.js";
import { clearTodoListTool } from "./clear.js";
import { createTodoTool } from "./create.js";
import { getTodoListTool } from "./get.js";
import { updateTodoTool } from "./update.js";

export { clearTodoListTool, createTodoTool, getTodoListTool, updateTodoTool };

export function createTodoTools(store: TodoStore = new TodoStore()): ToolHandler[] {
  return [
    createTodoTool(store),
    updateTodoTool(store),
    getTodoListTool(store),
    clearTodoListTool(store),
  ];
}
