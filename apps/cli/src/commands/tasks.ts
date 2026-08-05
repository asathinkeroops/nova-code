import type { CommandRecord, MonitorRecord } from "@nova/tools";

import { bold, dim, green, PURPLE_HEX, red, yellow } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import { pickerArrow } from "../ui/picker.js";
import { overlayNotice } from "./overlay-notice.js";

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
  if (status === "running") return yellow(t.tasks.running);
  if (status === "completed") return green(t.tasks.done);
  return red(t.tasks.failed);
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
  if (running > 0) parts.push(yellow(t.tasks.countRunning(running)));
  if (done > 0) parts.push(dim(t.tasks.countFinished(done)));
  return parts.join(dim(" · ")) || dim(t.tasks.none);
}

/** Kill one record by id, surfacing the outcome as a transient notice. */
function stopOne(ctx: CliContext, id: string): void {
  try {
    // Ids come from two disjoint namespaces (background commands and monitors),
    // so one `/tasks stop <id>` can serve both without ambiguity.
    if (ctx.monitorManager.get(id) !== undefined) {
      const stopped = ctx.monitorManager.stop(id);
      ctx.screen.notice(
        stopped.alreadyStopped
          ? t.tasks.alreadyFinished(id)
          : t.tasks.stopping(id, oneLine(stopped.description, 40)),
      );
      return;
    }
    const res = ctx.backgroundManager.kill(id);
    ctx.screen.notice(
      res.alreadyExited
        ? t.tasks.alreadyFinished(id)
        : t.tasks.stopping(id, oneLine(res.command, 40)),
    );
  } catch (err) {
    ctx.screen.notice(err instanceof Error ? err.message : String(err), undefined, "warn");
  }
}

/** A coloured dot for a monitor: only `running` is live; the rest are done. */
function monitorDot(m: MonitorRecord): string {
  if (m.status === "running") return yellow("●");
  if (m.status === "exited" || m.status === "stopped") return green("✓");
  return red("✗");
}

/**
 * Monitor rows appended to the `/tasks` list. Monitors are surfaced here — not
 * only through the model's stopMonitor tool — because a `persistent` watch
 * outlives every turn: with no user-visible list it would be an invisible
 * process the user can neither see nor stop.
 */
function monitorLines(records: MonitorRecord[]): string[] {
  if (records.length === 0) return [];
  const width = Math.min(
    CMD_MAX,
    Math.max(0, ...records.map((m) => oneLine(m.description, CMD_MAX).length)),
  );
  return [
    "",
    dim(t.tasks.monitorsHeader),
    ...records.map((m) => {
      const label = oneLine(m.description, CMD_MAX).padEnd(width);
      const tail = `${m.id}   ${t.tasks.eventCount(m.eventCount)}${m.persistent ? dim(" · persistent") : ""}`;
      return `${monitorDot(m)}   ${label}   ${dim(tail)}`;
    }),
  ];
}

/** Render a card listing every task — the non-interactive `/tasks list` form. */
function listCard(ctx: CliContext, records: CommandRecord[]): void {
  const cmdWidth = commandColumnWidth(records);
  const pidWidth = Math.max(0, ...records.map((r) => String(r.pid).length));
  const lines = records.map(
    (r) =>
      `${statusDot(r.status)}   ${oneLine(r.command, CMD_MAX).padEnd(cmdWidth)}   ${metaColumn(r, pidWidth)}`,
  );
  const body = [summary(records), "", ...lines, ...monitorLines(ctx.monitorManager.list())];
  ctx.screen.card(body.join("\n"), { title: TITLE });
}

/**
 * View and manage background commands (those started by `bash` with `run_in_background`).
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
      const records = ctx.backgroundManager.list();
      const monitors = ctx.monitorManager.list();
      if (records.length === 0 && monitors.length > 0) {
        ctx.screen.card(monitorLines(monitors).slice(1).join("\n"), { title: TITLE });
        return;
      }
      if (records.length === 0) {
        ctx.screen.card(dim(t.tasks.noneDot), { title: TITLE });
        return;
      }
      listCard(ctx, records);
      return;
    }
    if (verb === "stop" || verb === "kill") {
      const running = [
        ...ctx.backgroundManager.list().filter((r) => r.status === "running"),
        ...ctx.monitorManager.list().filter((m) => m.status === "running"),
      ];
      if (target === "all") {
        if (running.length === 0) {
          ctx.screen.card(dim(t.tasks.noRunning), { title: TITLE });
          return;
        }
        for (const r of running) stopOne(ctx, r.id);
        ctx.screen.card(t.tasks.stoppingN(running.length), {
          title: TITLE,
        });
        return;
      }
      if (!target) {
        ctx.screen.card(dim(t.tasks.usage), { title: TITLE, kind: "warn" });
        return;
      }
      stopOne(ctx, target);
      return;
    }
    ctx.screen.card(dim(t.tasks.unknownAction(verb ?? "")), {
      title: TITLE,
      kind: "warn",
    });
    return;
  }

  // Interactive modal: list → per-task action row, looping until dismissed.
  let cursor = 0;
  for (;;) {
    const records = ctx.backgroundManager.list();
    if (records.length === 0) {
      // The interactive picker covers background commands only; monitors are
      // listed (and stoppable by id) through the argument forms.
      const monitors = monitorLines(ctx.monitorManager.list());
      await overlayNotice(
        ctx,
        TITLE,
        monitors.length > 0 ? monitors.slice(1) : [dim(t.tasks.noneHint)],
      );
      return;
    }

    const cmdWidth = commandColumnWidth(records);
    const pidWidth = Math.max(0, ...records.map((r) => String(r.pid).length));
    const pick = await ctx.screen.pickOne<CommandRecord>({
      items: records,
      header: `${bold(t.tasks.header)}    ${summary(records)}\n`,
      footer: `\n${dim(t.tasks.listFooter)}`,
      pageSize: 12,
      initialIndex: Math.min(cursor, records.length - 1),
      render: (r, selected) =>
        `${pickerArrow(selected)}  ${statusDot(r.status)}   ${oneLine(r.command, CMD_MAX).padEnd(cmdWidth)}   ${metaColumn(r, pidWidth)}`,
      border: false,
      topRuleColor: PURPLE_HEX,
    });
    if (!pick) break;
    cursor = Math.max(
      0,
      records.findIndex((r) => r.id === pick.id),
    );

    await openTaskActions(ctx, pick.id);
  }
}

type Action = "view" | "stop";

/** Show the action row for one task, then perform the chosen action. */
async function openTaskActions(ctx: CliContext, id: string): Promise<void> {
  // Re-read: status may have changed while the list was open.
  const rec = ctx.backgroundManager.get(id);
  if (!rec) return;

  const actions: Action[] = rec.status === "running" ? ["view", "stop"] : ["view"];
  const action = await ctx.screen.pickHorizontal<Action>({
    items: actions,
    label: (a) => (a === "view" ? t.tasks.viewOutput : t.tasks.stop),
    header: `${statusDot(rec.status)} ${bold(oneLine(rec.command))}  ${dim(`${statusWord(rec.status)} · pid ${rec.pid}`)}`,
    footer: dim(t.tasks.actionFooter),
    border: false,
    topRuleColor: PURPLE_HEX,
  });
  if (!action) return;

  if (action === "stop") {
    stopOne(ctx, id);
    return;
  }

  // view: non-consuming snapshot so the completion notifier keeps its bytes.
  const snap = ctx.backgroundManager.peek(id);
  const lines = snap.output
    ? snap.output.replace(/\n$/, "").split("\n")
    : [dim(t.tasks.noOutputYet)];
  await ctx.screen.viewer({
    lines,
    header: `${bold(oneLine(snap.command))}  ${dim(statusWord(snap.status))}\n`,
    footer: `\n${dim(t.tasks.viewerFooter)}`,
    pageSize: 24,
    border: false,
    topRuleColor: PURPLE_HEX,
  });
}
