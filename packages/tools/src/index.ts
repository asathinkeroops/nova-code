import type { ToolHandler } from "@nova/core";
import { TodoStore } from "@nova/orchestration";
import { askUserQuestionTool } from "./builtin/ask-user.js";
import { bashTool } from "./builtin/bash.js";
import { editTool } from "./builtin/edit.js";
import { globTool } from "./builtin/glob.js";
import { grepTool } from "./builtin/grep.js";
import { readTool } from "./builtin/read.js";
import { createTodoTools } from "./builtin/todo/index.js";
import { webfetchTool } from "./builtin/webfetch.js";
import { websearchTool } from "./builtin/websearch.js";
import { writeTool } from "./builtin/write.js";

export { ToolRegistry } from "./registry.js";
export { createDispatcher, type DispatcherDeps } from "./dispatcher.js";
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
export { createTodoTool, getTodosTool, updateTodoTool, createTodoTools } from "./builtin/todo/index.js";

export function builtinTools(todoStore: TodoStore = new TodoStore()): ToolHandler[] {
  return [
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
}
