import type { ToolHandler, ToolPromptSection } from "@nova/core";
import type { TaskStore } from "./store.js";
import { clearTaskListTool } from "./clear.js";
import { createTaskTool } from "./create.js";
import { getTaskListTool } from "./list.js";
import { updateTaskTool } from "./update.js";
import { presentList } from "../prompt.js";

export {
  clearTaskListTool,
  createTaskTool,
  updateTaskTool,
  getTaskListTool,
};

const TASK_TOOL_NAMES = ["createTask", "updateTask", "getTaskList", "clearTaskList"] as const;

/** Tasks vs. todos: what earns a persisted plan. */
export const TASK_PROMPT: ToolPromptSection = {
  id: "task",
  order: 20,
  requires: ["createTask", "updateTask"],
  render: (ctx) =>
    `- For larger multi-step plans worth persisting across sessions, track them with ${presentList(ctx, TASK_TOOL_NAMES)} — same in_progress/completed discipline. Don't create a task for a single step or for work a todo already covers.`,
};

export function createTaskTools(store: TaskStore): ToolHandler[] {
  return [
    createTaskTool(store),
    updateTaskTool(store),
    getTaskListTool(store),
    clearTaskListTool(store),
  ];
}
