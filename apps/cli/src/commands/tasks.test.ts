import { describe, expect, it } from "vitest";

import type { CommandRecord } from "@nova/tools";

import type { CliContext } from "../context.js";
import { handleTasks } from "./tasks.js";

interface Card {
  text: string;
  opts: { title?: string; kind?: string };
}
interface Notice {
  text: string;
  tone?: string;
}
interface PickCall {
  items: CommandRecord[];
  header?: string;
  render: (item: CommandRecord, selected: boolean) => string;
}
interface HPickCall {
  items: string[];
  label: (item: string) => string;
  header?: string;
}
interface ViewerCall {
  lines: Array<string | { text: string; gutter?: string }>;
  header?: string;
}

/**
 * A minimal stand-in for the LongRunningCommandManager. `kills` records every
 * kill; `list()` returns the current records (tests can mutate the array to
 * simulate status changes between modal loops).
 */
function makeManager(records: CommandRecord[], kills: string[]) {
  return {
    list: () => records.slice(),
    get: (id: string) => records.find((r) => r.id === id),
    peek: (id: string) => {
      const r = records.find((x) => x.id === id);
      if (!r) throw new Error("unknown id");
      return { id: r.id, command: r.command, status: r.status, output: r.result ?? "" };
    },
    kill: (id: string) => {
      const r = records.find((x) => x.id === id);
      if (!r) throw new Error(`no background command with id ${id}`);
      kills.push(id);
      return { id, command: r.command, alreadyExited: r.status !== "running" };
    },
  };
}

interface CtxStub {
  cards: Card[];
  notices: Notice[];
  picks: PickCall[];
  hpicks: HPickCall[];
  viewers: ViewerCall[];
  ctx: CliContext;
}

/**
 * `pickResponses` is a queue of indices (or null to cancel) consumed by each
 * `pickOne` call; `hpickResponses` likewise drives the horizontal action row.
 */
function makeCtx(
  records: CommandRecord[],
  kills: string[],
  pickResponses: Array<number | null> = [],
  hpickResponses: Array<number | null> = [],
): CtxStub {
  const cards: Card[] = [];
  const notices: Notice[] = [];
  const picks: PickCall[] = [];
  const hpicks: HPickCall[] = [];
  const viewers: ViewerCall[] = [];
  const ctx = {
    longRunningManager: makeManager(records, kills),
    screen: {
      card: (text: string, opts: Card["opts"] = {}) => cards.push({ text, opts }),
      notice: (text: string, _ttl?: number, tone?: string) => notices.push({ text, tone }),
      pickOne: async (opts: PickCall) => {
        picks.push(opts);
        const choice = pickResponses.shift() ?? null;
        return choice === null ? null : (opts.items[choice] ?? null);
      },
      pickHorizontal: async (opts: HPickCall) => {
        hpicks.push(opts);
        const choice = hpickResponses.shift() ?? null;
        return choice === null ? null : (opts.items[choice] ?? null);
      },
      viewer: async (opts: ViewerCall) => {
        viewers.push(opts);
      },
    },
  } as unknown as CliContext;
  return { cards, notices, picks, hpicks, viewers, ctx };
}

function rec(over: Partial<CommandRecord> & Pick<CommandRecord, "id">): CommandRecord {
  return { pid: 100, command: "sleep 1", status: "running", ...over };
}

describe("handleTasks", () => {
  it("reports no tasks without opening a modal", async () => {
    const { ctx, cards, picks } = makeCtx([], []);
    await handleTasks(ctx, "");
    expect(picks).toHaveLength(0);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toMatch(/no background tasks/i);
  });

  it("lists running and finished tasks in the picker", async () => {
    const records = [
      rec({ id: "aaa", command: "npm run build", status: "running" }),
      rec({ id: "bbb", command: "echo done", status: "completed", result: "done\n" }),
    ];
    const { ctx, picks } = makeCtx(records, [], [null]);
    await handleTasks(ctx, "");
    expect(picks).toHaveLength(1);
    const rendered = picks[0]!.items.map((it) => picks[0]!.render(it, false)).join("\n");
    expect(rendered).toContain("npm run build");
    expect(rendered).toContain("echo done");
    expect(picks[0]!.header).toMatch(/1 running/);
  });

  it("opens an output viewer when 'View output' is chosen", async () => {
    const records = [rec({ id: "aaa", command: "echo hi", status: "completed", result: "hi\n" })];
    const { ctx, viewers } = makeCtx(records, [], [0, null], [0]);
    await handleTasks(ctx, "");
    expect(viewers).toHaveLength(1);
    expect(viewers[0]!.lines.join("\n")).toContain("hi");
  });

  it("offers Stop only for running tasks and kills the selected one", async () => {
    const kills: string[] = [];
    const records = [rec({ id: "aaa", command: "sleep 100", status: "running" })];
    // pick task 0, then choose action index 1 (Stop), then cancel the list.
    const { ctx, hpicks } = makeCtx(records, kills, [0, null], [1]);
    await handleTasks(ctx, "");
    expect(hpicks[0]!.items.map((a) => hpicks[0]!.label(a))).toEqual(["View output", "Stop"]);
    expect(kills).toEqual(["aaa"]);
  });

  it("does not offer Stop for finished tasks", async () => {
    const records = [rec({ id: "bbb", command: "echo x", status: "completed", result: "x\n" })];
    const { ctx, hpicks } = makeCtx(records, [], [0, null], [null]);
    await handleTasks(ctx, "");
    expect(hpicks[0]!.items.map((a) => hpicks[0]!.label(a))).toEqual(["View output"]);
  });

  it("`list` prints a summary card without a modal", async () => {
    const records = [
      rec({ id: "aaa", status: "running" }),
      rec({ id: "bbb", command: "echo x", status: "completed", result: "x\n" }),
    ];
    const { ctx, cards, picks } = makeCtx(records, []);
    await handleTasks(ctx, "list");
    expect(picks).toHaveLength(0);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toContain("aaa");
    expect(cards[0]?.text).toContain("bbb");
  });

  it("`stop <id>` kills a single task", async () => {
    const kills: string[] = [];
    const records = [rec({ id: "aaa", status: "running" })];
    const { ctx, notices } = makeCtx(records, kills);
    await handleTasks(ctx, "stop aaa");
    expect(kills).toEqual(["aaa"]);
    expect(notices.some((n) => n.text.includes("aaa"))).toBe(true);
  });

  it("`stop all` kills every running task only", async () => {
    const kills: string[] = [];
    const records = [
      rec({ id: "aaa", status: "running" }),
      rec({ id: "bbb", status: "running" }),
      rec({ id: "ccc", status: "completed", result: "x" }),
    ];
    const { ctx } = makeCtx(records, kills);
    await handleTasks(ctx, "stop all");
    expect(kills.sort()).toEqual(["aaa", "bbb"]);
  });

  it("warns on an unknown action", async () => {
    const { ctx, cards } = makeCtx([rec({ id: "aaa" })], []);
    await handleTasks(ctx, "frobnicate");
    expect(cards[0]?.opts.kind).toBe("warn");
    expect(cards[0]?.text).toMatch(/unknown action/i);
  });
});
