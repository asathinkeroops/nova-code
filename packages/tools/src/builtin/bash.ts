import { execa, type ExecaError } from "execa";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";

const inputSchema = z.object({
  command: z.string().min(1).describe("The shell command to execute (run with `bash -lc`)"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(10 * 60_000)
    .default(120_000)
    .describe("Timeout in milliseconds. Default 120000 (2 min)."),
  cwd: z.string().optional().describe("Working directory; defaults to the harness session cwd."),
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
      "Execute a shell command and return stdout+stderr. Use for running scripts, building, listing files, etc. Long-running commands time out at `timeout_ms`.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    try {
      const result = await execa(input.command, {
        shell: "/bin/bash",
        cwd: input.cwd ?? ctx.cwd,
        timeout: input.timeout_ms,
        all: true,
        reject: false,
        ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
      });
      const out = truncate(result.all ?? "");
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
        output: `bash failed: ${e.shortMessage ?? e.message ?? String(err)}\n${e.all ?? ""}`,
        isError: true,
      };
    }
  },
};
