import type { ToolHandler, ToolPromptSection } from "@nova/core";
import type { LspManager } from "@nova/lsp";
import { askUserQuestionTool } from "./ask-user.js";
import { bashTool, createBashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { createLspTool } from "./lsp.js";
import { createLoadSkillTool, LOAD_SKILL_PROMPT } from "./load-skill.js";
import { PLAN_MODE_PROMPT } from "./plan-mode.js";
import { readTool } from "./read.js";
import { getSkill, getSkillList, type SkillsOptions } from "./skills.js";
import { type TaskStore } from "./task/store.js";
import { createTaskTools, TASK_PROMPT } from "./task/index.js";
import { type CronStore } from "./cron/store.js";
import { createCronTools } from "./cron/index.js";
import { TodoStore } from "./todo/store.js";
import { createTodoTools, TODO_PROMPT } from "./todo/index.js";
import { type BackgroundCommandManager } from "./background/manager.js";
import { createBackgroundCommandTools, BACKGROUND_PROMPT } from "./background/index.js";
import { type MonitorManager } from "./monitor/manager.js";
import { createMonitorTools, MONITOR_PROMPT } from "./monitor/index.js";
import { webfetchTool } from "./webfetch.js";
import { createWebsearchTool, websearchTool, type WebsearchOptions } from "./websearch.js";
import { writeTool } from "./write.js";

export { ToolRegistry } from "./registry.js";
export { createDispatcher, type DispatcherDeps } from "./dispatcher.js";
export {
  renderToolPrompts,
  staticSection,
  presentList,
  type RenderedToolPrompts,
} from "./prompt.js";
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
  TODO_PROMPT,
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
  TASK_PROMPT,
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
  BACKGROUND_PROMPT,
  type BackgroundNotifierHook,
} from "./background/index.js";
export {
  MonitorManager,
  MonitorError,
  monitorTool,
  stopMonitorTool,
  createMonitorTools,
  makeMonitorNotifier,
  MONITOR_PROMPT,
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
  LOAD_SKILL_PROMPT,
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
  PLAN_MODE_PROMPT,
  type PlanExitDecision,
  type PlanModeDeps,
} from "./plan-mode.js";

/**
 * System-prompt guidance for the builtin tools, one section per family.
 *
 * A LIST, not a derivation of {@link builtinTools}: the gate is the final tool
 * set the host renders against — which includes tools this package never sees
 * (`createSubAgent`, MCP) and excludes ones `permissions.deny` removed. The
 * host concatenates its own sections onto this and calls
 * {@link renderToolPrompts}.
 *
 * A family whose guidance belongs in its tool description instead (read, glob,
 * websearch, lsp, cron) contributes nothing here — a section earns its place
 * only when it spans several tools or teaches a tradeoff between them.
 */
export const BUILTIN_TOOL_PROMPTS: readonly ToolPromptSection[] = [
  TODO_PROMPT,
  TASK_PROMPT,
  BACKGROUND_PROMPT,
  MONITOR_PROMPT,
  LOAD_SKILL_PROMPT,
  PLAN_MODE_PROMPT,
];

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
