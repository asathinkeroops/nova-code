import { describe, expect, it } from "vitest";
import type { ToolContext } from "@nova/core";
import { LongRunningCommandManager, type CommandRecord } from "./manager.js";
import { runInBackgroundTool } from "./run.js";

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
    const { id } = JSON.parse(runRes.output) as { id: string };
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);

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
