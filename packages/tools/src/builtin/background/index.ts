import type { ToolHandler } from "@nova/core";
import type { BackgroundCommandManager } from "./manager.js";
import { runInBackgroundTool } from "./run.js";
import { killBackgroundTool } from "./kill.js";
import { getBackgroundOutputTool } from "./output.js";

export { runInBackgroundTool } from "./run.js";
export { killBackgroundTool } from "./kill.js";
export { getBackgroundOutputTool } from "./output.js";
export { makeBackgroundNotifier, type BackgroundNotifierHook } from "./notifier.js";

export function createBackgroundCommandTools(manager: BackgroundCommandManager): ToolHandler[] {
  return [
    runInBackgroundTool(manager),
    killBackgroundTool(manager),
    getBackgroundOutputTool(manager),
  ];
}
