import type { ToolHandler } from "@nova/core";
import type { LspManager } from "@nova/lsp";
import { askUserQuestionTool } from "./builtin/ask-user.js";
import { bashTool, createBashTool } from "./builtin/bash.js";
import { editTool } from "./builtin/edit.js";
import { globTool } from "./builtin/glob.js";
import { grepTool } from "./builtin/grep.js";
import { createLspTool } from "./builtin/lsp.js";
import { createLoadSkillTool } from "./builtin/load-skill.js";
import { readTool } from "./builtin/read.js";
import { getSkill, getSkillList, type SkillsOptions } from "./builtin/skills.js";
import { type TaskStore } from "./builtin/task/store.js";
import { createTaskTools } from "./builtin/task/index.js";
import { type CronStore } from "./builtin/cron/store.js";
import { createCronTools } from "./builtin/cron/index.js";
import { TodoStore } from "./builtin/todo/store.js";
import { createTodoTools } from "./builtin/todo/index.js";
import { type BackgroundCommandManager } from "./builtin/background/manager.js";
import { createBackgroundCommandTools } from "./builtin/background/index.js";
import { type MonitorManager } from "./builtin/monitor/manager.js";
import { createMonitorTools } from "./builtin/monitor/index.js";
import { webfetchTool } from "./builtin/webfetch.js";
import { createWebsearchTool, websearchTool, type WebsearchOptions } from "./builtin/websearch.js";
import { writeTool } from "./builtin/write.js";

export { ToolRegistry } from "./registry.js";
export { createDispatcher, type DispatcherDeps } from "./dispatcher.js";
export { withAliases, aliasedPath, PATH_ALIASES } from "./schema.js";
export {
  askUserQuestionTool,
  bashTool,
  createBashTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  webfetchTool,
  websearchTool,
  createWebsearchTool,
  writeTool,
};
export type { WebsearchKeys, WebsearchOptions } from "./builtin/websearch.js";
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
  createCronTool,
  listCronTool,
  deleteCronTool,
  createCronTools,
} from "./builtin/cron/index.js";
export {
  CronStore,
  CronError,
  DEFAULT_CRON_LIMITS,
  type CronLimits,
  type CronCreateInput,
  type CronListFilter,
} from "./builtin/cron/store.js";
export { type CronEntry, type ScheduleSpec } from "./builtin/cron/schema.js";
export {
  parseDuration,
  formatDuration,
  parseSchedule,
  parseCron,
  nextCronFire,
  type CronFields,
} from "./builtin/cron/parse.js";
export {
  killBackgroundTool,
  createBackgroundCommandTools,
  makeBackgroundNotifier,
  type BackgroundNotifierHook,
} from "./builtin/background/index.js";
export {
  MonitorManager,
  MonitorError,
  monitorTool,
  stopMonitorTool,
  createMonitorTools,
  makeMonitorNotifier,
  type MonitorNotifierHook,
  type MonitorRecord,
  type MonitorStatus,
  type MonitorEvents,
  type MonitorOptions,
  type StartMonitorInput,
} from "./builtin/monitor/index.js";
export {
  BackgroundCommandManager,
  BackgroundCommandError,
  type CommandRecord,
  type CommandStatus,
  type ManagerOptions as BackgroundManagerOptions,
  type StartInput as BackgroundStartInput,
} from "./builtin/background/manager.js";
export {
  getSkill,
  getSkillList,
  type LoadedSkill,
  type SkillListItem,
  type SkillsLogger,
  type SkillsOptions,
} from "./builtin/skills.js";
export {
  createLoadSkillTool,
  expandSkillBody,
  renderSkillPayload,
  bashRunnerFor,
  type GetSkillFn,
  type LoadSkillOptions,
  type ExpandSkillOptions,
} from "./builtin/load-skill.js";
export { createLspTool } from "./builtin/lsp.js";
export {
  createPlanModeTools,
  ENTER_PLAN_MODE_TOOL,
  EXIT_PLAN_MODE_TOOL,
  PLAN_MODE_TOOL_NAMES,
  type PlanExitDecision,
  type PlanModeDeps,
} from "./builtin/plan-mode.js";

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
  backgroundManager?: BackgroundCommandManager,
  lspManager?: LspManager,
  cronStore?: CronStore,
  monitorManager?: MonitorManager,
  websearch?: WebsearchOptions,
): ToolHandler[] {
  const tools: ToolHandler[] = [
    // bash owns both the foreground and the background command path — the
    // manager (when present) enables its `run_in_background` branch.
    createBashTool(backgroundManager),
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    webfetchTool,
    // Provider API keys come from settings.websearch; each falls back to its
    // env var inside the tool, so the keyless case still works.
    createWebsearchTool(websearch ?? {}),
    askUserQuestionTool,
    ...createTodoTools(todoStore),
  ];
  if (taskStore) {
    tools.push(...createTaskTools(taskStore));
  }
  if (backgroundManager) {
    tools.push(...createBackgroundCommandTools(backgroundManager));
  }
  if (monitorManager) {
    tools.push(...createMonitorTools(monitorManager));
  }
  if (lspManager) {
    tools.push(createLspTool(lspManager));
  }
  if (cronStore) {
    tools.push(...createCronTools(cronStore));
  }
  if (skills && getSkillList(skills).length > 0) {
    tools.push(
      createLoadSkillTool(
        (input) => getSkill(input, skills),
        {
          ...(skills.maxResponseBytes !== undefined
            ? { maxResponseBytes: skills.maxResponseBytes }
            : {}),
          ...(skills.disableShellExecution ? { disableShellExecution: true } : {}),
        },
      ),
    );
  }
  return tools;
}
