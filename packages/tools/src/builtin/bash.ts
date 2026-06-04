import { execa, type ExecaError } from "execa";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";

const inputSchema = z.object({
  command: z.string().min(1).describe("The shell command to execute (run with `bash -lc`)"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(60_000)
    .describe(
      "Timeout in milliseconds. Default and max 60000 (60s). Anything that " +
        "might take longer should be launched with runLongRunningCommand instead.",
    ),
  cwd: z.string().optional().describe("Working directory; defaults to the nova session cwd."),
});

const MAX_OUTPUT = 200_000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n…(truncated ${s.length - MAX_OUTPUT} bytes)`;
}

export const bashTool: ToolHandler = {
  definition: {
    name: "bash",
    description:
      "Execute a short, blocking shell command and return stdout+stderr. " +
      "Use for quick scripts, lookups, builds that finish in seconds, etc. " +
      "Hard cap is 60 seconds — for anything that might take longer (dev " +
      "servers, watchers, long builds, sleeps, downloads) use " +
      "runLongRunningCommand instead.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    // When an OS sandbox is wired in (ctx.sandbox), confine the command before
    // spawning. wrapCommand returns the command unchanged when sandboxing is
    // inactive, so the no-sandbox path is unaffected. We still execa with
    // shell:/bin/bash — the wrapped string carries its own sandbox-exec/bwrap
    // invocation around an inner `/bin/bash -c`.
    const command = ctx.sandbox
      ? await ctx.sandbox.wrapCommand(input.command, ctx.signal)
      : input.command;
    // Annotate against the ORIGINAL command — the sandbox keys violations by the
    // unwrapped command string. No-op when there are no violations.
    const annotate = (s: string): string =>
      ctx.sandbox ? ctx.sandbox.annotateOutput(input.command, s) : s;
    try {
      const result = await execa(command, {
        shell: "/bin/bash",
        cwd: input.cwd ?? ctx.cwd,
        timeout: input.timeout_ms,
        all: true,
        reject: false,
        ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
      });
      const out = truncate(annotate(result.all ?? ""));
      if (result.failed || (result.exitCode ?? 0) !== 0) {
        return {
          output: `exit=${result.exitCode ?? "?"} ${result.signal ? `signal=${result.signal} ` : ""}\n${out}`,
          isError: true,
        };
      }
      return { output: out };
    } catch (err) {
      const e = err as ExecaError;
      return {
        output: `bash failed: ${e.shortMessage ?? e.message ?? String(err)}\n${annotate(typeof e.all === "string" ? e.all : "")}`,
        isError: true,
      };
    } finally {
      ctx.sandbox?.afterCommand();
    }
  },
};
