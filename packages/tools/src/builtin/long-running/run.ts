import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import { LongRunningCommandError, type LongRunningCommandManager } from "./manager.js";

const inputSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .describe("Shell command to launch in the background (run with `bash -lc`)."),
    cwd: z
      .string()
      .optional()
      .describe("Working directory; defaults to the nova session cwd."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Extra environment variables merged onto the inherited env."),
  })
  .strict();

export function runLongRunningCommandTool(
  manager: LongRunningCommandManager,
): ToolHandler {
  return {
    definition: {
      name: "runLongRunningCommand",
      description:
        "Spawn a shell command in the background and return its id immediately. " +
        "Use this for dev servers, watchers, or any work that should keep running " +
        "across multiple tool calls. Poll completion with checkLongRunningCommand. " +
        "Children are killed when the nova session exits.",
      inputSchema,
    },
    async run(rawInput, ctx) {
      const input = inputSchema.parse(rawInput);
      try {
        const { id } = manager.start({
          command: input.command,
          cwd: input.cwd ?? ctx.cwd,
          ...(input.env ? { env: input.env } : {}),
        });
        return { output: JSON.stringify({ id }) };
      } catch (err) {
        const msg =
          err instanceof LongRunningCommandError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return { output: `runLongRunningCommand failed: ${msg}`, isError: true };
      }
    },
  };
}
