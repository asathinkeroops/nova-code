import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import { BackgroundCommandError, type BackgroundCommandManager } from "./manager.js";

const inputSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .describe("Shell command to launch in the background (run with `bash -lc`)."),
    cwd: z.string().optional().describe("Working directory; defaults to the nova session cwd."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Extra environment variables merged onto the inherited env."),
  })
  .strict();

export function runInBackgroundTool(manager: BackgroundCommandManager): ToolHandler {
  return {
    definition: {
      name: "runInBackground",
      description:
        "Spawn a shell command in the background and return its id and pid " +
        "immediately. Use this for dev servers, watchers, or any work that should " +
        "keep running across multiple tool calls. When the command finishes, its " +
        "captured output is delivered to you automatically — you do not need to " +
        "poll. Terminate one early with killBackground; all children are killed " +
        "when the nova session exits.",
      inputSchema,
    },
    async run(rawInput, ctx) {
      const input = inputSchema.parse(rawInput);
      try {
        // Confine background commands too when a sandbox is wired in. Unlike
        // bash, the child outlives this call, so per-command cleanup
        // (afterCommand) is left to session-end dispose — the sandbox's
        // mount-point cleanup is reference-counted and won't disturb a still-
        // running child. wrapCommand is a passthrough when sandboxing is off.
        const command = ctx.sandbox
          ? await ctx.sandbox.wrapCommand(input.command, ctx.signal)
          : input.command;
        const { id, pid } = manager.start({
          command,
          // Record the original command, not the sandbox-wrapped form, so
          // `/tasks` and completion notices show what was actually requested.
          label: input.command,
          cwd: input.cwd ?? ctx.cwd,
          ...(input.env ? { env: input.env } : {}),
        });
        return { output: JSON.stringify({ id, pid }) };
      } catch (err) {
        const msg =
          err instanceof BackgroundCommandError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return { output: `runInBackground failed: ${msg}`, isError: true };
      }
    },
  };
}
