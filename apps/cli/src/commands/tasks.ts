import type { CommandRecord } from "@nova/tools";

import { bold, dim, green, red, yellow } from "../colors.js";
import type { CliContext } from "../context.js";
import { pickerArrow } from "../ui/picker.js";

const TITLE = "/tasks";

/** Max width of the command column; longer commands are ellipsised. */
const CMD_MAX = 52;

/** A coloured status dot: running = yellow, completed = green, errored = red. */
function statusDot(status: CommandRecord["status"]): string {
  if (status === "running") return yellow("●");
  if (status === "completed") return green("✓");
  return red("✗");
}

function statusWord(status: CommandRecord["status"]): string {
  if (status === "running") return yellow("running");
  if (status === "completed") return green("done");
  return red("failed");
}

/** Collapse a (possibly multi-line) command to a single, length-capped line. */
function oneLine(command: string, max = 60): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Width of the command column across a record set (capped at {@link CMD_MAX}). */
function commandColumnWidth(records: CommandRecord[]): number {
  return Math.min(CMD_MAX, Math.max(0, ...records.map((r) => oneLine(r.command, CMD_MAX).length)));
}

/** A dim, right-hand metadata column: short id and pid, pid right-aligned. */
function metaColumn(r: CommandRecord, pidWidth: number): string {
  return dim(`${r.id}   pid ${String(r.pid).padStart(pidWidth)}`);
}

/** Headline summarising how many tasks are running vs finished. */
function summary(records: CommandRecord[]): string {
  const running = records.filter((r) => r.status === "running").length;
  const done = records.length - running;
  const parts: string[] = [];
  if (running > 0) parts.push(yellow(`${running} running`));
  if (done > 0) parts.push(dim(`${done} finished`));
  return parts.join(dim(" · ")) || dim("no background tasks");
}

/** Kill one record by id, surfacing the outcome as a transient notice. */
function stopOne(ctx: CliContext, id: string): void {
  try {
    const res = ctx.longRunningManager.kill(id);
    ctx.screen.notice(
      res.alreadyExited
        ? `task ${id} had already finished`
        : `stopping ${id} (${oneLine(res.command, 40)})…`,
    );
  } catch (err) {
    ctx.screen.notice(err instanceof Error ? err.message : String(err), undefined, "warn");
  }
}

/** Render a card listing every task — the non-interactive `/tasks list` form. */
function listCard(ctx: CliContext, records: CommandRecord[]): void {
  const cmdWidth = commandColumnWidth(records);
  const pidWidth = Math.max(0, ...records.map((r) => String(r.pid).length));
  const lines = records.map(
    (r) =>
      `${statusDot(r.status)}   ${oneLine(r.command, CMD_MAX).padEnd(cmdWidth)}   ${metaColumn(r, pidWidth)}`,
  );
  ctx.screen.card([summary(records), "", ...lines].join("\n"), { title: TITLE });
}

/**
 * View and manage background commands (those started by `runInBackground`).
 *
 * With no argument, opens an interactive modal: a list of running/finished
 * tasks → an action row per task (view output / stop). The two loop until the
 * list is dismissed, like `/diff`. Argument shortcuts work without a TTY:
 *   `/tasks list`            — print a one-card summary
 *   `/tasks stop <id>`       — stop a single task (alias `kill`)
 *   `/tasks stop all`        — stop every running task
 */
export async function handleTasks(ctx: CliContext, args: string): Promise<void> {
  const arg = args.trim();

  // Argument shortcuts — usable in headless runs where modals don't open.
  if (arg) {
    const [verb, ...rest] = arg.split(/\s+/);
    const target = rest.join(" ").trim();
    if (verb === "list") {
      const records = ctx.longRunningManager.list();
      if (records.length === 0) {
        ctx.screen.card(dim("no background tasks."), { title: TITLE });
        return;
      }
      listCard(ctx, records);
      return;
    }
    if (verb === "stop" || verb === "kill") {
      const running = ctx.longRunningManager.list().filter((r) => r.status === "running");
      if (target === "all") {
        if (running.length === 0) {
          ctx.screen.card(dim("no running tasks to stop."), { title: TITLE });
          return;
        }
        for (const r of running) stopOne(ctx, r.id);
        ctx.screen.card(`stopping ${running.length} task${running.length === 1 ? "" : "s"}…`, {
          title: TITLE,
        });
        return;
      }
      if (!target) {
        ctx.screen.card(dim("usage: /tasks stop <id|all>"), { title: TITLE, kind: "warn" });
        return;
      }
      stopOne(ctx, target);
      return;
    }
    ctx.screen.card(dim(`unknown action "${verb}" — try: list, stop <id|all>`), {
      title: TITLE,
      kind: "warn",
    });
    return;
  }

  // Interactive modal: list → per-task action row, looping until dismissed.
  let cursor = 0;
  for (;;) {
    const records = ctx.longRunningManager.list();
    if (records.length === 0) {
      ctx.screen.card(dim("no background tasks — start one with the runInBackground tool."), {
        title: TITLE,
      });
      return;
    }

    const cmdWidth = commandColumnWidth(records);
    const pidWidth = Math.max(0, ...records.map((r) => String(r.pid).length));
    const pick = await ctx.screen.pickOne<CommandRecord>({
      items: records,
      header: `${bold("Background tasks")}    ${summary(records)}\n`,
      footer: `\n${dim("↑↓ navigate · enter open · esc close")}`,
      pageSize: 12,
      initialIndex: Math.min(cursor, records.length - 1),
      render: (r, selected) =>
        `${pickerArrow(selected)}  ${statusDot(r.status)}   ${oneLine(r.command, CMD_MAX).padEnd(cmdWidth)}   ${metaColumn(r, pidWidth)}`,
    });
    if (!pick) break;
    cursor = Math.max(0, records.findIndex((r) => r.id === pick.id));

    await openTaskActions(ctx, pick.id);
  }
}

type Action = "view" | "stop";

/** Show the action row for one task, then perform the chosen action. */
async function openTaskActions(ctx: CliContext, id: string): Promise<void> {
  // Re-read: status may have changed while the list was open.
  const rec = ctx.longRunningManager.get(id);
  if (!rec) return;

  const actions: Action[] = rec.status === "running" ? ["view", "stop"] : ["view"];
  const action = await ctx.screen.pickHorizontal<Action>({
    items: actions,
    label: (a) => (a === "view" ? "View output" : "Stop"),
    header: `${statusDot(rec.status)} ${bold(oneLine(rec.command))}  ${dim(`${statusWord(rec.status)} · pid ${rec.pid}`)}`,
    footer: dim("←→ choose · enter select · esc back"),
  });
  if (!action) return;

  if (action === "stop") {
    stopOne(ctx, id);
    return;
  }

  // view: non-consuming snapshot so the completion notifier keeps its bytes.
  const snap = ctx.longRunningManager.peek(id);
  const lines = snap.output ? snap.output.replace(/\n$/, "").split("\n") : [dim("(no output yet)")];
  await ctx.screen.viewer({
    lines,
    header: `${bold(oneLine(snap.command))}  ${dim(statusWord(snap.status))}\n`,
    footer: `\n${dim("↑↓/PgUp/PgDn scroll · g/G top/bottom · enter/esc/q back")}`,
    pageSize: 24,
  });
}
