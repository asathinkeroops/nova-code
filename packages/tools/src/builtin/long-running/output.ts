import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import { LongRunningCommandError, type LongRunningCommandManager } from "./manager.js";

const inputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe("The id returned by runInBackground for the command to read."),
    filter: z
      .string()
      .optional()
      .describe(
        "Optional regular expression; only output lines matching it are returned.",
      ),
  })
  .strict();

function applyFilter(output: string, pattern: string): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // An invalid regex shouldn't blow up the read — fall back to raw output.
    return output;
  }
  return output
    .split("\n")
    .filter((line) => re.test(line))
    .join("\n");
}

export function getBackgroundOutputTool(
  manager: LongRunningCommandManager,
): ToolHandler {
  return {
    definition: {
      name: "getBackgroundOutput",
      description:
        "Read new output from a background command (started with " +
        "runInBackground), by id. Returns only the output produced since your " +
        "last read — call repeatedly to follow a dev server or watcher. Works " +
        "while the command is still running and after it exits.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        const res = manager.read(input.id);
        const body =
          input.filter !== undefined
            ? applyFilter(res.output, input.filter)
            : res.output;
        const notes: string[] = [`status=${res.status}`];
        if (res.droppedBytes > 0) {
          notes.push(`dropped ${res.droppedBytes} bytes before this read`);
        }
        const header = `[${notes.join("; ")}]`;
        const text = body.length > 0 ? `${header}\n${body}` : `${header}\n[no new output]`;
        return { output: text };
      } catch (err) {
        const msg =
          err instanceof LongRunningCommandError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return { output: `getBackgroundOutput failed: ${msg}`, isError: true };
      }
    },
  };
}
