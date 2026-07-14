import { formatDuration, parseDuration, type CronEntry } from "@nova/tools";
import { dim } from "../colors.js";
import type { CliContext } from "../context.js";

const TITLE = "/loop";
const USAGE = "usage: /loop <interval> <prompt|/command>  ·  /loop stop  ·  interval like 30s, 5m, 1h";

/** The single `/loop`-created schedule for this session, or undefined. */
async function currentLoop(ctx: CliContext): Promise<CronEntry | undefined> {
  return (await ctx.cronStore.list({ source: "loop" }))[0];
}

/** One-line summary of the running loop for the status card. */
function statusLine(loop: CronEntry): string {
  const every =
    loop.schedule.kind === "interval" ? formatDuration(loop.schedule.intervalMs) : loop.schedule.expr;
  return `looping every ${every} (${loop.iterations}/${loop.maxIterations})\n${dim(loop.payload)}`;
}

/**
 * `/loop` — schedule a prompt or slash command to re-run on a fixed interval. A
 * thin wrapper over the cron mechanism: it creates a single `source:"loop"` entry
 * (one at a time) that the scheduler arms and the REPL drives (see `runDueCron` in
 * repl.ts). An interval is mandatory. Stops via `/loop stop`, `/clear`, `/resume`,
 * or exit — Esc only aborts the current iteration and the schedule survives.
 */
export async function handleLoop(ctx: CliContext, args: string): Promise<void> {
  const trimmed = args.trim();

  // No args → status if a loop is running, else usage.
  if (trimmed === "") {
    const loop = await currentLoop(ctx);
    if (loop) {
      ctx.screen.card(statusLine(loop), { title: TITLE });
    } else {
      ctx.screen.card(dim(USAGE), { title: TITLE });
    }
    return;
  }

  if (trimmed === "stop") {
    const loop = await currentLoop(ctx);
    if (loop) {
      await ctx.cronStore.delete(loop.id);
      ctx.screen.notice("loop stopped");
    } else {
      ctx.screen.notice("no active loop", 2000, "warn");
    }
    return;
  }

  // <interval> <payload…>
  const firstSpace = trimmed.search(/\s/);
  const intervalTok = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const payload = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  const intervalMs = parseDuration(intervalTok);
  if (intervalMs === null) {
    ctx.screen.card(`invalid interval "${intervalTok}" — expected e.g. 30s, 5m, 1h.\n${dim(USAGE)}`, {
      kind: "error",
      title: TITLE,
    });
    return;
  }
  if (!payload) {
    ctx.screen.card(`missing prompt or command to loop.\n${dim(USAGE)}`, {
      kind: "error",
      title: TITLE,
    });
    return;
  }
  const minMs = ctx.settings.loop.minIntervalMs;
  if (intervalMs < minMs) {
    ctx.screen.card(
      `interval too short — minimum is ${formatDuration(minMs)} (settings.loop.minIntervalMs).`,
      { kind: "error", title: TITLE },
    );
    return;
  }
  // No self-nesting: a `/loop` payload would replace the loop on every tick.
  if (/^\/loop(\s|$)/i.test(payload)) {
    ctx.screen.card("a loop can't run /loop as its payload.", { kind: "error", title: TITLE });
    return;
  }

  // Replace any existing loop (only one at a time).
  const existing = await currentLoop(ctx);
  if (existing) await ctx.cronStore.delete(existing.id);
  // Interval entries fire immediately (nextRunAt = now); the scheduler arms a
  // 0ms timer, so the first iteration runs on the next idle REPL pass and the
  // interval re-arms completion-relative after each turn.
  await ctx.cronStore.create({
    schedule: { kind: "interval", intervalMs },
    payload,
    source: "loop",
    maxIterations: ctx.settings.loop.maxIterations,
  });
  ctx.screen.card(
    `${existing ? "replaced loop — " : ""}running now, then every ${formatDuration(intervalMs)}` +
      ` after each run completes (max ${ctx.settings.loop.maxIterations}). /loop stop to end.\n${dim(payload)}`,
    { title: TITLE },
  );
}
