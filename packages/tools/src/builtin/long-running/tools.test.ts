import { describe, expect, it } from "vitest";
import type { ToolContext } from "@nova/core";
import { LongRunningCommandManager } from "./manager.js";
import { runLongRunningCommandTool } from "./run.js";
import { checkLongRunningCommandTool } from "./check.js";

const ctx: ToolContext = { cwd: process.cwd() };

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("runLongRunningCommand / checkLongRunningCommand", () => {
  it("run returns an id; check by id returns the record", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runLongRunningCommandTool(mgr);
    const checkTool = checkLongRunningCommandTool(mgr);

    const runRes = await runTool.run({ command: "echo hi" }, ctx);
    expect(runRes.isError).toBeUndefined();
    const { id } = JSON.parse(runRes.output) as { id: string };
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);

    await waitFor(() => mgr.get(id)?.status !== "running");

    const checkRes = await checkTool.run({ id }, ctx);
    const view = JSON.parse(checkRes.output) as {
      id: string;
      command: string;
      status: string;
      pid?: unknown;
      result?: unknown;
    };
    expect(view.id).toBe(id);
    expect(view.command).toBe("echo hi");
    expect(view.status).toBe("completed");
    expect(view.pid).toBeUndefined();
    expect(view.result).toBeUndefined();
    expect(Object.keys(view).sort()).toEqual(["command", "id", "status"]);
  });

  it("check with no id returns all records", async () => {
    const mgr = new LongRunningCommandManager();
    const runTool = runLongRunningCommandTool(mgr);
    const checkTool = checkLongRunningCommandTool(mgr);

    await runTool.run({ command: "echo a" }, ctx);
    await runTool.run({ command: "echo b" }, ctx);

    const res = await checkTool.run({}, ctx);
    const { records } = JSON.parse(res.output) as { records: unknown[] };
    expect(records).toHaveLength(2);
  });

  it("check with unknown id returns isError", async () => {
    const mgr = new LongRunningCommandManager();
    const checkTool = checkLongRunningCommandTool(mgr);
    const res = await checkTool.run({ id: "doesNotExist" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("no such command id");
  });

  it("run reports the manager error when concurrency cap is hit", async () => {
    const mgr = new LongRunningCommandManager({ maxConcurrent: 1 });
    const runTool = runLongRunningCommandTool(mgr);

    await runTool.run({ command: "sleep 1" }, ctx);
    const second = await runTool.run({ command: "echo nope" }, ctx);
    expect(second.isError).toBe(true);
    expect(second.output).toContain("concurrent command limit");
  });
});
