import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import { LongRunningCommandError, type LongRunningCommandManager } from "./manager.js";

const inputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe("The id returned by runInBackground for the command to terminate."),
  })
  .strict();

export function killBackgroundTool(
  manager: LongRunningCommandManager,
): ToolHandler {
  return {
    definition: {
      name: "killBackground",
      description:
        "Terminate a background command started with runInBackground, by id. " +
        "Sends SIGTERM and escalates to SIGKILL if it lingers; the command's " +
        "final output is still delivered to you when it exits. No-op if the " +
        "command has already finished.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        const res = manager.kill(input.id);
        return {
          output: JSON.stringify({
            id: res.id,
            status: res.alreadyExited ? "already-exited" : "terminating",
          }),
        };
      } catch (err) {
        const msg =
          err instanceof LongRunningCommandError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return { output: `killBackground failed: ${msg}`, isError: true };
      }
    },
  };
}
