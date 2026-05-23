import type { ToolHandler } from "@nova/core";
import { TodoStore } from "@nova/orchestration";
import { createTodoTool } from "./create.js";
import { getTodosTool } from "./get.js";
import { updateTodoTool } from "./update.js";

export { createTodoTool, getTodosTool, updateTodoTool };

export function createTodoTools(store: TodoStore = new TodoStore()): ToolHandler[] {
  return [createTodoTool(store), updateTodoTool(store), getTodosTool(store)];
}
