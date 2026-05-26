import type { ToolHandler } from "@nova/core";
import { askUserQuestionTool } from "./builtin/ask-user.js";
import { bashTool } from "./builtin/bash.js";
import { editTool } from "./builtin/edit.js";
import { globTool } from "./builtin/glob.js";
import { grepTool } from "./builtin/grep.js";
import { createLoadSkillTool } from "./builtin/load-skill.js";
import { readTool } from "./builtin/read.js";
import { getSkill, getSkillList, type SkillsOptions } from "./builtin/skills.js";
import { type TaskStore } from "./builtin/task/store.js";
import { createTaskTools } from "./builtin/task/index.js";
import { TodoStore } from "./builtin/todo/store.js";
import { createTodoTools } from "./builtin/todo/index.js";
import { webfetchTool } from "./builtin/webfetch.js";
import { websearchTool } from "./builtin/websearch.js";
import { writeTool } from "./builtin/write.js";

export { ToolRegistry } from "./registry.js";
export { createDispatcher, type DispatcherDeps } from "./dispatcher.js";
export {
  InMemoryFileAccessLedger,
  createInvariants,
  type InvariantsCheck,
  type InvariantsOptions,
} from "./invariants.js";
export {
  askUserQuestionTool,
  bashTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  webfetchTool,
  websearchTool,
  writeTool,
};
export {
  createTodoTool,
  getTodoListTool,
  updateTodoTool,
  clearTodoListTool,
  createTodoTools,
} from "./builtin/todo/index.js";
export { TodoStore, TodoError, type Todo, type TodoStatus } from "./builtin/todo/store.js";
export {
  makeTodoReminder,
  type TodoReminderOptions,
  type InterjectFn,
  type InterjectCtx,
} from "./builtin/todo/reminder.js";
export {
  createTaskTool,
  updateTaskTool,
  getTaskTool,
  getTaskListTool,
  clearTaskListTool,
  createTaskTools,
} from "./builtin/task/index.js";
export {
  TaskStore,
  TaskError,
  type Task,
  type TaskStatus,
  type TaskUpdatePatch,
} from "./builtin/task/store.js";
export { makeTaskReminder, type TaskReminderOptions } from "./builtin/task/reminder.js";
export {
  getSkill,
  getSkillList,
  type LoadedSkill,
  type SkillListItem,
  type SkillsLogger,
  type SkillsOptions,
} from "./builtin/skills.js";
export { createLoadSkillTool, type GetSkillFn } from "./builtin/load-skill.js";

/**
 * Build the default set of builtin tools.
 *
 * When `skills` is provided, the loadSkill tool is auto-registered iff
 * `getSkillList(skills)` returns at least one entry. The tool's lookup
 * closure shares the same `skills` options, so it sees the same cached
 * scan — no separate plumbing needed.
 */
export function builtinTools(
  todoStore: TodoStore = new TodoStore(),
  skills?: SkillsOptions,
  taskStore?: TaskStore,
): ToolHandler[] {
  const tools: ToolHandler[] = [
    bashTool,
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    webfetchTool,
    websearchTool,
    askUserQuestionTool,
    ...createTodoTools(todoStore),
  ];
  if (taskStore) {
    tools.push(...createTaskTools(taskStore));
  }
  if (skills && getSkillList(skills).length > 0) {
    tools.push(
      createLoadSkillTool(
        (input) => getSkill(input, skills),
        skills.maxResponseBytes !== undefined
          ? { maxResponseBytes: skills.maxResponseBytes }
          : undefined,
      ),
    );
  }
  return tools;
}
