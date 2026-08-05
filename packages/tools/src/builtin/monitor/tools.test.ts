import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@nova/core";
import { MonitorManager } from "./manager.js";
import { monitorTool, stopMonitorTool, createMonitorTools } from "./tools.js";

const ctx: ToolContext = { cwd: process.cwd() };

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("monitor tool", () => {
  it("registers exactly the start/stop pair", () => {
    const names = createMonitorTools(new MonitorManager()).map((t) => t.definition.name);
    expect(names).toEqual(["monitor", "stopMonitor"]);
  });

  it("returns the id, what it is watching, and the log path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-mt-"));
    const mgr = new MonitorManager({ outputDir: dir });
    const res = await monitorTool(mgr).run({ command: "echo hi", description: "greetings" }, ctx);

    expect(res.isError).toBeUndefined();
    const out = JSON.parse(res.output) as {
      id: string;
      pid: number;
      watching: string;
      persistent: boolean;
      log_path: string;
    };
    expect(out.watching).toBe("greetings");
    expect(out.persistent).toBe(false);
    expect(out.pid).toBeGreaterThan(0);
    expect(out.log_path).toBe(join(dir, `${out.id}.log`));

    await waitFor(() => mgr.get(out.id)?.status === "exited");
    expect(readFileSync(out.log_path, "utf8")).toContain("hi");
  });

  it("returns immediately for an unbounded watch (does not block)", async () => {
    const mgr = new MonitorManager();
    const res = await monitorTool(mgr).run({ command: "sleep 30", description: "long watch" }, ctx);
    const { id } = JSON.parse(res.output) as { id: string };
    expect(mgr.get(id)?.status).toBe("running");
    await mgr.disposeAll();
  });

  it("honours persistent", async () => {
    const mgr = new MonitorManager();
    const res = await monitorTool(mgr).run(
      { command: "sleep 30", description: "forever", persistent: true },
      ctx,
    );
    const out = JSON.parse(res.output) as { id: string; persistent: boolean };
    expect(out.persistent).toBe(true);
    expect(mgr.get(out.id)?.persistent).toBe(true);
    await mgr.disposeAll();
  });

  it("surfaces the concurrency cap as a tool error, not a throw", async () => {
    const mgr = new MonitorManager({ maxConcurrent: 1 });
    const tool = monitorTool(mgr);
    await tool.run({ command: "sleep 5", description: "first" }, ctx);

    const second = await tool.run({ command: "sleep 5", description: "second" }, ctx);
    expect(second.isError).toBe(true);
    expect(second.output).toContain("monitor limit reached");
    await mgr.disposeAll();
  });

  it("rejects a timeout past the one-hour ceiling", async () => {
    const mgr = new MonitorManager();
    await expect(
      monitorTool(mgr).run({ command: "echo x", description: "d", timeout_ms: 3_600_001 }, ctx),
    ).rejects.toThrow();
  });
});

describe("stopMonitor tool", () => {
  it("stops a running watch", async () => {
    const mgr = new MonitorManager();
    const res = await monitorTool(mgr).run({ command: "sleep 30", description: "w" }, ctx);
    const { id } = JSON.parse(res.output) as { id: string };
    await waitFor(() => mgr.get(id)?.status === "running");

    const stopped = await stopMonitorTool(mgr).run({ id }, ctx);
    expect(JSON.parse(stopped.output)).toEqual({ id, watching: "w", status: "stopping" });
    await waitFor(() => mgr.get(id)?.status === "stopped");
  });

  it("is a no-op for an already-finished watch", async () => {
    const mgr = new MonitorManager();
    const res = await monitorTool(mgr).run({ command: "echo x", description: "w" }, ctx);
    const { id } = JSON.parse(res.output) as { id: string };
    await waitFor(() => mgr.get(id)?.status === "exited");

    const stopped = await stopMonitorTool(mgr).run({ id }, ctx);
    expect(JSON.parse(stopped.output).status).toBe("already-stopped");
  });

  it("reports an unknown id as a tool error", async () => {
    const res = await stopMonitorTool(new MonitorManager()).run({ id: "nope" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("no monitor with id nope");
  });
});
