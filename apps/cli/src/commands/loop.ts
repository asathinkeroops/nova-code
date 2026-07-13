import { dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { LoopController, formatDuration, parseDuration } from "../loop-controller.js";

const TITLE = "/loop";
const USAGE = "usage: /loop <interval> <prompt|/command>  ·  /loop stop  ·  interval like 30s, 5m, 1h";

/** One-line summary of the running loop for the status card. */
function statusLine(loop: LoopController): string {
  return (
    `looping every ${formatDuration(loop.intervalMs)} ` +
    `(${loop.count()}/${loop.maxIterations})\n${dim(loop.payload)}`
  );
}

/**
 * `/loop` — schedule a prompt or slash command to re-run on a fixed interval.
 * State lives on `ctx.loop`; the REPL main loop drives each iteration (see
 * `runLoopIteration` in repl.ts). An interval is mandatory. Stops via
 * `/loop stop`, `/clear`, `/resume`, or exit — Esc only aborts the current
 * iteration and the schedule survives.
 */
export async function handleLoop(ctx: CliContext, args: string): Promise<void> {
  const trimmed = args.trim();

  // No args → status if a loop is running, else usage.
  if (trimmed === "") {
    if (ctx.loop) {
      ctx.screen.card(statusLine(ctx.loop), { title: TITLE });
    } else {
      ctx.screen.card(dim(USAGE), { title: TITLE });
    }
    return;
  }

  if (trimmed === "stop") {
    if (ctx.loop) {
      ctx.loop.stop();
      ctx.loop = null;
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
  const replacing = ctx.loop !== null;
  ctx.loop?.stop();
  const loop = new LoopController({
    payload,
    intervalMs,
    maxIterations: ctx.settings.loop.maxIterations,
    wake: () => ctx.screen.wake(),
  });
  // Run the first iteration now; the REPL re-arms the interval after each turn
  // completes (completion-relative, so iterations never overlap).
  loop.armFirst();
  ctx.loop = loop;
  ctx.screen.card(
    `${replacing ? "replaced loop — " : ""}running now, then every ${formatDuration(intervalMs)}` +
      ` after each run completes (max ${loop.maxIterations}). /loop stop to end.\n${dim(payload)}`,
    { title: TITLE },
  );
}
