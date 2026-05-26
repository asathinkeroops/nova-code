import type { ToolHandler } from "@nova/core";
import { checkLongRunningCommandTool } from "./check.js";
import type { LongRunningCommandManager } from "./manager.js";
import { runLongRunningCommandTool } from "./run.js";

export { runLongRunningCommandTool } from "./run.js";
export { checkLongRunningCommandTool } from "./check.js";
export { makeLongRunningNotifier, type LongRunningNotifierHook } from "./notifier.js";

export function createLongRunningCommandTools(
  manager: LongRunningCommandManager,
): ToolHandler[] {
  return [
    runLongRunningCommandTool(manager),
    checkLongRunningCommandTool(manager),
  ];
}
