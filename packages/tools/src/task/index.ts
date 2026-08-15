import type { ToolHandler } from "@nova/core";
import type { TaskStore } from "./store.js";
import { clearTaskListTool } from "./clear.js";
import { createTaskTool } from "./create.js";
import { getTaskListTool } from "./list.js";
import { updateTaskTool } from "./update.js";

export {
  clearTaskListTool,
  createTaskTool,
  updateTaskTool,
  getTaskListTool,
};

export function createTaskTools(store: TaskStore): ToolHandler[] {
  return [
    createTaskTool(store),
    updateTaskTool(store),
    getTaskListTool(store),
    clearTaskListTool(store),
  ];
}
