import type { ToolHandler } from "@nova/core";
import type { LongRunningCommandManager } from "./manager.js";
import { runInBackgroundTool } from "./run.js";
import { killBackgroundTool } from "./kill.js";
import { getBackgroundOutputTool } from "./output.js";

export { runInBackgroundTool } from "./run.js";
export { killBackgroundTool } from "./kill.js";
export { getBackgroundOutputTool } from "./output.js";
export { makeLongRunningNotifier, type LongRunningNotifierHook } from "./notifier.js";

export function createLongRunningCommandTools(
  manager: LongRunningCommandManager,
): ToolHandler[] {
  return [
    runInBackgroundTool(manager),
    killBackgroundTool(manager),
    getBackgroundOutputTool(manager),
  ];
}
