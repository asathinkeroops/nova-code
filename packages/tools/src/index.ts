import type { ToolHandler } from "@nova/core";
import type { LspManager } from "@nova/lsp";
import { askUserQuestionTool } from "./ask-user.js";
import { bashTool, createBashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { createLspTool } from "./lsp.js";
import { createLoadSkillTool } from "./load-skill.js";
import { readTool } from "./read.js";
import { getSkill, getSkillList, type SkillsOptions } from "./skills.js";
import { type TaskStore } from "./task/store.js";
import { createTaskTools } from "./task/index.js";
import { type CronStore } from "./cron/store.js";
import { createCronTools } from "./cron/index.js";
import { TodoStore } from "./todo/store.js";
import { createTodoTools } from "./todo/index.js";
import { type BackgroundCommandManager } from "./background/manager.js";
import { createBackgroundCommandTools } from "./background/index.js";
import { type MonitorManager } from "./monitor/manager.js";
import { createMonitorTools } from "./monitor/index.js";
import { webfetchTool } from "./webfetch.js";
import { createWebsearchTool, websearchTool, type WebsearchOptions } from "./websearch.js";
import { writeTool } from "./write.js";

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
export type { WebsearchKeys, WebsearchOptions } from "./websearch.js";
export {
  createTodoTool,
  getTodoListTool,
  updateTodoTool,
  clearTodoListTool,
  createTodoTools,
} from "./todo/index.js";
export { TodoStore, TodoError, type Todo, type TodoStatus } from "./todo/store.js";
export {
  makeTodoReminder,
  type TodoReminderOptions,
  type InterjectFn,
  type InterjectCtx,
} from "./todo/reminder.js";
export {
  createTaskTool,
  updateTaskTool,
  getTaskListTool,
  clearTaskListTool,
  createTaskTools,
} from "./task/index.js";
export {
  TaskStore,
  TaskError,
  type Task,
  type TaskStatus,
  type TaskUpdatePatch,
} from "./task/store.js";
export { makeTaskReminder, type TaskReminderOptions } from "./task/reminder.js";
export {
  createCronTool,
  listCronTool,
  deleteCronTool,
  createCronTools,
} from "./cron/index.js";
export {
  CronStore,
  CronError,
  DEFAULT_CRON_LIMITS,
  type CronLimits,
  type CronCreateInput,
  type CronListFilter,
} from "./cron/store.js";
export { type CronEntry, type ScheduleSpec } from "./cron/schema.js";
export {
  parseDuration,
  formatDuration,
  parseSchedule,
  parseCron,
  nextCronFire,
  type CronFields,
} from "./cron/parse.js";
export {
  killBackgroundTool,
  createBackgroundCommandTools,
  makeBackgroundNotifier,
  type BackgroundNotifierHook,
} from "./background/index.js";
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
} from "./monitor/index.js";
export {
  BackgroundCommandManager,
  BackgroundCommandError,
  type CommandRecord,
  type CommandStatus,
  type ManagerOptions as BackgroundManagerOptions,
  type StartInput as BackgroundStartInput,
} from "./background/manager.js";
export {
  getSkill,
  getSkillList,
  type LoadedSkill,
  type SkillListItem,
  type SkillsLogger,
  type SkillsOptions,
} from "./skills.js";
export {
  createLoadSkillTool,
  expandSkillBody,
  renderSkillPayload,
  bashRunnerFor,
  type GetSkillFn,
  type LoadSkillOptions,
  type ExpandSkillOptions,
} from "./load-skill.js";
export { createLspTool } from "./lsp.js";
export {
  createPlanModeTools,
  ENTER_PLAN_MODE_TOOL,
  EXIT_PLAN_MODE_TOOL,
  PLAN_MODE_TOOL_NAMES,
  type PlanExitDecision,
  type PlanModeDeps,
} from "./plan-mode.js";

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
