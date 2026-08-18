export {
  MonitorManager,
  MonitorError,
  type MonitorRecord,
  type MonitorStatus,
  type MonitorEvents,
  type MonitorOptions,
  type StartMonitorInput,
} from "./manager.js";
export { monitorTool, stopMonitorTool, createMonitorTools } from "./tools.js";
export { makeMonitorNotifier, type MonitorNotifierHook } from "./notifier.js";

import type { ToolPromptSection } from "@nova/core";
import { staticSection } from "../prompt.js";

/** Every-occurrence (monitor) vs. once (a background command that exits). */
export const MONITOR_PROMPT: ToolPromptSection = staticSection({
  id: "monitor",
  order: 40,
  requires: ["monitor"],
  text: "- Use monitor when you need to hear about EVERY occurrence of something (a log tail, a watcher, a poll loop): each stdout line of its script becomes a notification. For a SINGLE notification (a build finishing, a port opening) use bash run_in_background with a command that exits when the condition holds — not monitor, whose unbounded scripts stay armed until stopped.",
});
