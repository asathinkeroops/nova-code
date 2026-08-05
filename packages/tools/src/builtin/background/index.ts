import type { ToolHandler } from "@nova/core";
import type { BackgroundCommandManager } from "./manager.js";
import { killBackgroundTool } from "./kill.js";

export { killBackgroundTool } from "./kill.js";
export { makeBackgroundNotifier, type BackgroundNotifierHook } from "./notifier.js";

/**
 * Model-facing tools for background commands. Starting one is NOT here — it is
 * the `bash` tool's `run_in_background` branch (see `../bash.ts`), and reading
 * one back is the ordinary `read`/`grep` on the `output_path` that branch
 * returns. That leaves termination as the only thing needing a dedicated tool.
 */
export function createBackgroundCommandTools(manager: BackgroundCommandManager): ToolHandler[] {
  return [killBackgroundTool(manager)];
}
