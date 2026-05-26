import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { CommandRecord, CommandStatus, LongRunningCommandManager } from "./manager.js";

const inputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe("Command id returned by runLongRunningCommand. Omit to list all known commands."),
  })
  .strict();

interface CommandStatusView {
  id: string;
  command: string;
  status: CommandStatus;
}

function statusView(r: CommandRecord): CommandStatusView {
  return { id: r.id, command: r.command, status: r.status };
}

export function checkLongRunningCommandTool(manager: LongRunningCommandManager): ToolHandler {
  return {
    definition: {
      name: "checkLongRunningCommand",
      description:
        "Query the status of a background command started with runLongRunningCommand. " +
        "With an id, returns { id, command, status }. " +
        "Without an id, returns { records: [...] } for every known command in this session. " +
        "status is one of running | completed | error. " +
        "This tool only surfaces status — the captured output is not returned.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      if (input.id === undefined) {
        return {
          output: JSON.stringify({ records: manager.list().map(statusView) }),
        };
      }
      const record = manager.get(input.id);
      if (!record) {
        return {
          output: `no such command id: ${input.id}`,
          isError: true,
        };
      }
      return { output: JSON.stringify(statusView(record)) };
    },
  };
}
