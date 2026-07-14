import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { CronStore } from "./store.js";

const inputSchema = z
  .object({
    status: z
      .enum(["active", "stopped"])
      .optional()
      .describe("Filter by status. Omit to return both active and stopped schedules."),
  })
  .strict();

export function listCronTool(store: CronStore): ToolHandler {
  return {
    definition: {
      name: "cronList",
      description:
        "List scheduled entries for this session. Optionally filter by status. Returns a JSON " +
        "array of { id, label, schedule, payload, source, status, iterations, maxIterations, " +
        "createdAt, nextRunAt, lastRunAt } (timestamps are epoch ms). Order is not guaranteed.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        const entries = await store.list(input.status ? { status: input.status } : undefined);
        return { output: JSON.stringify(entries) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `cronList failed: ${msg}`, isError: true };
      }
    },
  };
}
