import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { CronStore } from "./store.js";
import { parseSchedule } from "./parse.js";

const inputSchema = z
  .object({
    schedule: z
      .string()
      .min(1)
      .describe(
        "When to run. Either a recurring interval — `30s`, `5m`, `1h` — or a standard " +
          "5-field cron expression `minute hour day-of-month month day-of-week`, " +
          'e.g. `0 9 * * *` (daily 09:00) or `*/15 * * * *` (every 15 min).',
      ),
    payload: z
      .string()
      .min(1)
      .describe(
        "What to run each time: a plain prompt (runs as an agent turn) or a `/command`. " +
          "Fires only while a nova session is active (there is no background daemon).",
      ),
    label: z.string().optional().describe("Optional human-readable name for the schedule."),
    maxIterations: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Stop after this many runs. Defaults to settings.cron.maxIterations."),
  })
  .strict();

// A cron payload must not schedule/unschedule crons or loops, or it could spawn a
// runaway on every tick.
const SELF_NESTING = /^\s*\/(loop|cron)\b/i;

export function createCronTool(store: CronStore): ToolHandler {
  return {
    definition: {
      name: "cronCreate",
      description:
        "Schedule a prompt or /command to run on a recurring interval or cron expression. " +
        "Entries persist to the session and re-arm on /resume; they fire only while a session " +
        "is active. Returns the created schedule as JSON. Manage with cronList / cronDelete.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      const spec = parseSchedule(input.schedule);
      if (!spec) {
        return {
          output: `cronCreate failed: invalid schedule "${input.schedule}" — expected an interval like 5m/1h or a 5-field cron expression like "0 9 * * *".`,
          isError: true,
        };
      }
      if (SELF_NESTING.test(input.payload)) {
        return {
          output: "cronCreate failed: a schedule can't run /loop or /cron as its payload.",
          isError: true,
        };
      }
      if (spec.kind === "interval" && spec.intervalMs < store.limits.minIntervalMs) {
        return {
          output: `cronCreate failed: interval too short — minimum is ${store.limits.minIntervalMs}ms (settings.cron.minIntervalMs).`,
          isError: true,
        };
      }
      try {
        const entry = await store.create({
          schedule: spec,
          payload: input.payload,
          source: "tool",
          maxIterations: input.maxIterations ?? store.limits.maxIterations,
          ...(input.label !== undefined ? { label: input.label } : {}),
        });
        return { output: JSON.stringify(entry) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `cronCreate failed: ${msg}`, isError: true };
      }
    },
  };
}
