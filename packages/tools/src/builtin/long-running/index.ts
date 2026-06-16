import type { ToolHandler } from "@nova/core";
import type { LongRunningCommandManager } from "./manager.js";
import { runInBackgroundTool } from "./run.js";

export { runInBackgroundTool } from "./run.js";
export { makeLongRunningNotifier, type LongRunningNotifierHook } from "./notifier.js";

export function createLongRunningCommandTools(
  manager: LongRunningCommandManager,
): ToolHandler[] {
  return [runInBackgroundTool(manager)];
}
