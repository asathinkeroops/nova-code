import { describe, expect, it } from "vitest";
import type { ToolContext } from "@nova/core";
import { LongRunningCommandManager, type CommandRecord } from "./manager.js";
import { runInBackgroundTool } from "./run.js";
import { killBackgroundTool } from "./kill.js";
import { getBackgroundOutputTool } from "./output.js";

const ctx: ToolContext = { cwd: process.cwd() };

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("runInBackground", () => {
  it("run returns an id; the record reaches completed", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runInBackgroundTool(mgr);

    const runRes = await runTool.run({ command: "echo hi" }, ctx);
    expect(runRes.isError).toBeUndefined();
    const { id, pid } = JSON.parse(runRes.output) as { id: string; pid: number };
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pid).toBeGreaterThan(0);

    await waitFor(() => mgr.get(id)?.status !== "running");
    expect(mgr.get(id)?.status).toBe("completed");
  });

  it("emits 'complete' with the public record and marks pending until drained", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runInBackgroundTool(mgr);

    const completed: CommandRecord[] = [];
    mgr.onComplete((r) => completed.push(r));

    const runRes = await runTool.run({ command: "echo hi" }, ctx);
    const { id } = JSON.parse(runRes.output) as { id: string };

    await waitFor(() => completed.length > 0);
    expect(completed[0]?.id).toBe(id);
    expect(completed[0]?.status).toBe("completed");

    // Completion is queued for the notifier until drained.
    expect(mgr.hasPending()).toBe(true);
    expect(mgr.drainNotifications()).toContain(id);
    expect(mgr.hasPending()).toBe(false);
    expect(mgr.drainNotifications()).toEqual([]);
  });

  it("emits 'complete' for a failing command with an error record", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runInBackgroundTool(mgr);

    const completed: CommandRecord[] = [];
    mgr.onComplete((r) => completed.push(r));

    await runTool.run({ command: "exit 3" }, ctx);

    await waitFor(() => completed.length > 0);
    expect(completed[0]?.status).toBe("error");
    expect(mgr.hasPending()).toBe(true);
  });

  it("run reports the manager error when concurrency cap is hit", async () => {
    const mgr = new LongRunningCommandManager({ maxConcurrent: 1 });
    const runTool = runInBackgroundTool(mgr);

    await runTool.run({ command: "sleep 1" }, ctx);
    const second = await runTool.run({ command: "echo nope" }, ctx);
    expect(second.isError).toBe(true);
    expect(second.output).toContain("concurrent command limit");
  });
});

describe("killBackground", () => {
  it("terminates a running command and reports the error completion", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runInBackgroundTool(mgr);
    const killTool = killBackgroundTool(mgr);

    const completed: CommandRecord[] = [];
    mgr.onComplete((r) => completed.push(r));

    const runRes = await runTool.run({ command: "sleep 30" }, ctx);
    const { id } = JSON.parse(runRes.output) as { id: string };
    await waitFor(() => mgr.get(id)?.status === "running");

    const killRes = await killTool.run({ id }, ctx);
    expect(killRes.isError).toBeUndefined();
    expect(JSON.parse(killRes.output)).toEqual({ id, status: "terminating" });

    await waitFor(() => completed.length > 0);
    expect(completed[0]?.id).toBe(id);
    expect(completed[0]?.status).toBe("error");
  });

  it("is a no-op for an already-finished command", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runInBackgroundTool(mgr);
    const killTool = killBackgroundTool(mgr);

    const runRes = await runTool.run({ command: "echo hi" }, ctx);
    const { id } = JSON.parse(runRes.output) as { id: string };
    await waitFor(() => mgr.get(id)?.status === "completed");

    const killRes = await killTool.run({ id }, ctx);
    expect(killRes.isError).toBeUndefined();
    expect(JSON.parse(killRes.output)).toEqual({ id, status: "already-exited" });
  });

  it("reports an error for an unknown id", async () => {
    const mgr = new LongRunningCommandManager();
    const killTool = killBackgroundTool(mgr);

    const killRes = await killTool.run({ id: "nope" }, ctx);
    expect(killRes.isError).toBe(true);
    expect(killRes.output).toContain("no background command with id nope");
  });
});

describe("getBackgroundOutput", () => {
  it("returns new output incrementally and is empty on a second read", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runInBackgroundTool(mgr);
    const outTool = getBackgroundOutputTool(mgr);

    const runRes = await runTool.run({ command: "echo hello" }, ctx);
    const { id } = JSON.parse(runRes.output) as { id: string };
    await waitFor(() => mgr.get(id)?.status === "completed");

    const first = await outTool.run({ id }, ctx);
    expect(first.isError).toBeUndefined();
    expect(first.output).toContain("hello");
    expect(first.output).toContain("status=completed");

    // The first read consumed the output; nothing new remains.
    const second = await outTool.run({ id }, ctx);
    expect(second.output).toContain("[no new output]");
  });

  it("follows output across multiple reads while running", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runInBackgroundTool(mgr);

    const runRes = await runTool.run(
      { command: "echo one; sleep 0.3; echo two; sleep 5" },
      ctx,
    );
    const { id } = JSON.parse(runRes.output) as { id: string };

    // First chunk: "one" is available well before the command exits.
    let seen = "";
    await waitFor(() => {
      seen += mgr.read(id).output;
      return seen.includes("one");
    });
    expect(mgr.get(id)?.status).toBe("running");

    // Later chunk: "two" arrives on a subsequent read; "one" is not repeated.
    let later = "";
    await waitFor(() => {
      later += mgr.read(id).output;
      return later.includes("two");
    });
    expect(later).not.toContain("one");

    await killTool(mgr, id);
  });

  it("applies a line filter", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runInBackgroundTool(mgr);
    const outTool = getBackgroundOutputTool(mgr);

    const runRes = await runTool.run(
      { command: "printf 'info: a\\nerror: boom\\ninfo: b\\n'" },
      ctx,
    );
    const { id } = JSON.parse(runRes.output) as { id: string };
    await waitFor(() => mgr.get(id)?.status === "completed");

    const res = await outTool.run({ id, filter: "^error:" }, ctx);
    expect(res.output).toContain("error: boom");
    expect(res.output).not.toContain("info:");
  });

  it("reports an error for an unknown id", async () => {
    const mgr = new LongRunningCommandManager();
    const outTool = getBackgroundOutputTool(mgr);

    const res = await outTool.run({ id: "nope" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("no background command with id nope");
  });
});

async function killTool(
  mgr: LongRunningCommandManager,
  id: string,
): Promise<void> {
  await killBackgroundTool(mgr).run({ id }, ctx);
}
