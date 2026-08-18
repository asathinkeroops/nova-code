import type { ToolHandler, ToolPromptSection } from "@nova/core";
import type { BackgroundCommandManager } from "./manager.js";
import { killBackgroundTool } from "./kill.js";
import { staticSection } from "../prompt.js";

export { killBackgroundTool } from "./kill.js";
export { makeBackgroundNotifier, type BackgroundNotifierHook } from "./notifier.js";

/**
 * How to run something long-lived, and why polling for its exit is wasted.
 *
 * Gated on `killBackground` rather than on `bash`: starting a background
 * command is bash's `run_in_background` branch, which only exists when a
 * manager was wired — and `killBackground` is exactly the tool that manager
 * brings. Gating on `bash` alone would advertise the branch on a session
 * running without one.
 */
export const BACKGROUND_PROMPT: ToolPromptSection = staticSection({
  id: "background",
  order: 30,
  requires: ["bash", "killBackground"],
  text: "- Run long-lived commands (dev servers, watchers, builds) with bash's run_in_background; it returns immediately with an output_path — the command's full stdout+stderr log. Read or grep that file whenever you need its output, while it runs or after. You are told automatically when the command finishes (with its exit status), so never poll waiting for that; read the log only when you actually want the output.",
});

/**
 * Model-facing tools for background commands. Starting one is NOT here — it is
 * the `bash` tool's `run_in_background` branch (see `../bash.ts`), and reading
 * one back is the ordinary `read`/`grep` on the `output_path` that branch
 * returns. That leaves termination as the only thing needing a dedicated tool.
 */
export function createBackgroundCommandTools(manager: BackgroundCommandManager): ToolHandler[] {
  return [killBackgroundTool(manager)];
}
