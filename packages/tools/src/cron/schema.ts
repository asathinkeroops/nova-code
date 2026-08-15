import { z } from "zod";

/**
 * A schedule is either a recurring interval (`5m`/`1h`, the grammar `/loop` uses)
 * or a standard 5-field cron expression. One discriminated union so a single entry
 * covers both flavours.
 */
export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), intervalMs: z.number().int().positive() }),
  z.object({ kind: z.literal("cron"), expr: z.string().min(1) }),
]);

export type ScheduleSpec = z.infer<typeof scheduleSchema>;

/**
 * One scheduled entry. Persisted verbatim as `${sessionDir}/cron/{id}.json`.
 *
 * `nextRunAt` is authoritative on disk for `cron` entries (an absolute wall-clock
 * next-fire that survives a resume). For `interval` entries it is advisory — the
 * scheduler re-arms them relative to load time, since completion-relative cadence
 * can't be reconstructed across a restart. `source:"loop"` entries get the `/loop`
 * UX (one at a time, immediate first fire); `source:"tool"` come from the agent.
 */
export const cronEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  schedule: scheduleSchema,
  payload: z.string().min(1),
  isCommand: z.boolean(),
  source: z.enum(["tool", "loop"]),
  status: z.enum(["active", "stopped"]),
  iterations: z.number().int().nonnegative().default(0),
  maxIterations: z.number().int().positive(),
  createdAt: z.number().int(),
  nextRunAt: z.number().int().nullable(),
  lastRunAt: z.number().int().nullable(),
});

export type CronEntry = z.infer<typeof cronEntrySchema>;
