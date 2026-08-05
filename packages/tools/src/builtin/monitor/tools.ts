import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import { MonitorError, type MonitorManager } from "./manager.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;

const startSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .describe(
        "Shell script whose stdout lines are the events. Every pipe stage must " +
          "flush per line — `grep --line-buffered`, `awk '{print; fflush()}'`; " +
          "`| head -N` cannot flush at all and will deliver nothing.",
      ),
    description: z
      .string()
      .min(1)
      .describe(
        "What is being watched, e.g. 'errors in deploy.log'. Shown on every " +
          "notification, so make it specific.",
      ),
    cwd: z.string().optional().describe("Working directory; defaults to the nova session cwd."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Extra environment variables merged onto the inherited env."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_TIMEOUT_MS)
      .describe(
        `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}, ` +
          `max ${MAX_TIMEOUT_MS}. Ignored when persistent is true.`,
      ),
    persistent: z
      .boolean()
      .default(false)
      .describe(
        "Run for the lifetime of the session with no deadline. Use for " +
          "session-length watches (log tails, PR polling); stop with stopMonitor.",
      ),
  })
  .strict();

export function monitorTool(manager: MonitorManager): ToolHandler {
  return {
    definition: {
      name: "monitor",
      description:
        "Watch something and get told about each occurrence, without polling. " +
        "The script runs in the background and EVERY LINE IT PRINTS TO STDOUT " +
        "becomes a notification delivered to you; the script exiting ends the " +
        "watch.\n" +
        "Pick by how many notifications you need: ONE (a build finishing, a " +
        "server becoming ready) — do NOT use this, use bash with " +
        "run_in_background and a command that exits when the condition holds, " +
        "e.g. `until grep -q 'Ready' dev.log; do sleep 0.5; done`. MANY, one " +
        "per occurrence — that is this tool: `tail -f`, `inotifywait -m`, or a " +
        "`while true` poll loop.\n" +
        "Filter inside the command, not afterwards — only the lines you would " +
        "act on should reach stdout. Cover FAILURE too: a filter matching only " +
        "the success marker stays silent through a crash, and silence is " +
        "indistinguishable from 'still running'. Prefer " +
        "`grep -E --line-buffered 'ready|Error|Traceback|FAILED|Killed'` over " +
        "matching progress alone.\n" +
        "stderr is NOT an event stream — it goes to the monitor's log file, " +
        "readable with `read`. Merge it with 2>&1 if its lines should notify. " +
        "A monitor that floods is stopped automatically; restart it with a " +
        "tighter filter.",
      inputSchema: startSchema,
    },
    async run(rawInput, ctx) {
      const input = startSchema.parse(rawInput);
      try {
        // Confine the watch script like any other subprocess. It outlives this
        // call, so per-command sandbox cleanup is left to session-end dispose.
        const command = ctx.sandbox
          ? await ctx.sandbox.wrapCommand(input.command, ctx.signal)
          : input.command;
        const rec = manager.start({
          command,
          label: input.command,
          description: input.description,
          cwd: input.cwd ?? ctx.cwd,
          persistent: input.persistent,
          timeoutMs: input.timeout_ms,
          ...(input.env ? { env: input.env } : {}),
        });
        if (rec.status === "failed") {
          return {
            output: `monitor failed to start: ${rec.reason ?? "unknown error"}`,
            isError: true,
          };
        }
        return {
          output: JSON.stringify({
            id: rec.id,
            pid: rec.pid,
            watching: rec.description,
            persistent: rec.persistent,
            ...(rec.outputPath ? { log_path: rec.outputPath } : {}),
          }),
        };
      } catch (err) {
        const msg = err instanceof MonitorError || err instanceof Error ? err.message : String(err);
        return { output: `monitor failed: ${msg}`, isError: true };
      }
    },
  };
}

const stopSchema = z
  .object({
    id: z.string().min(1).describe("The id returned by the monitor tool."),
  })
  .strict();

export function stopMonitorTool(manager: MonitorManager): ToolHandler {
  return {
    definition: {
      name: "stopMonitor",
      description:
        "Stop a watch started with the monitor tool, by id. Already-finished " +
        "monitors are a no-op. All monitors are stopped when the session exits.",
      inputSchema: stopSchema,
    },
    async run(rawInput) {
      const input = stopSchema.parse(rawInput);
      try {
        const res = manager.stop(input.id);
        return {
          output: JSON.stringify({
            id: res.id,
            watching: res.description,
            status: res.alreadyStopped ? "already-stopped" : "stopping",
          }),
        };
      } catch (err) {
        const msg = err instanceof MonitorError || err instanceof Error ? err.message : String(err);
        return { output: `stopMonitor failed: ${msg}`, isError: true };
      }
    },
  };
}

export function createMonitorTools(manager: MonitorManager): ToolHandler[] {
  return [monitorTool(manager), stopMonitorTool(manager)];
}
