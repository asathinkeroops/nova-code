import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@nova/core";
import { BackgroundCommandManager, type CommandRecord } from "./manager.js";
import { createBashTool } from "../bash.js";
import { killBackgroundTool } from "./kill.js";

const ctx: ToolContext = { cwd: process.cwd() };

/** Launch through the merged `bash` tool, the only way to start a command now. */
function bg(mgr: BackgroundCommandManager) {
  const tool = createBashTool(mgr);
  return (command: string) => tool.run({ command, run_in_background: true }, ctx);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("bash run_in_background", () => {
  it("returns an id; the record reaches completed", async () => {
    const mgr = new BackgroundCommandManager();

    const runRes = await bg(mgr)("echo hi");
    expect(runRes.isError).toBeUndefined();
    const { id, pid } = JSON.parse(runRes.output) as { id: string; pid: number };
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pid).toBeGreaterThan(0);

    await waitFor(() => mgr.get(id)?.status !== "running");
    expect(mgr.get(id)?.status).toBe("completed");
  });

  it("does not block: a long command returns while still running", async () => {
    const mgr = new BackgroundCommandManager();

    const runRes = await bg(mgr)("sleep 30");
    const { id } = JSON.parse(runRes.output) as { id: string };
    expect(mgr.get(id)?.status).toBe("running");

    await killBackgroundTool(mgr).run({ id }, ctx);
  });

  it("emits 'complete' with the public record and marks pending until drained", async () => {
    const mgr = new BackgroundCommandManager();

    const completed: CommandRecord[] = [];
    mgr.onComplete((r) => completed.push(r));

    const runRes = await bg(mgr)("echo hi");
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
    const mgr = new BackgroundCommandManager();

    const completed: CommandRecord[] = [];
    mgr.onComplete((r) => completed.push(r));

    await bg(mgr)("exit 3");

    await waitFor(() => completed.length > 0);
    expect(completed[0]?.status).toBe("error");
    expect(mgr.hasPending()).toBe(true);
  });

  it("reports the manager error when the concurrency cap is hit", async () => {
    const mgr = new BackgroundCommandManager({ maxConcurrent: 1 });
    const start = bg(mgr);

    await start("sleep 1");
    const second = await start("echo nope");
    expect(second.isError).toBe(true);
    expect(second.output).toContain("concurrent command limit");
  });

  it("rejects run_in_background when no manager is wired in", async () => {
    const res = await createBashTool().run({ command: "echo hi", run_in_background: true }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("run_in_background is unavailable");
  });

  it("still runs foreground commands normally", async () => {
    const res = await createBashTool(new BackgroundCommandManager()).run(
      { command: "echo sync", timeout_ms: 5000 },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("sync");
  });
});

describe("background output file", () => {
  it("returns an output_path whose file follows the command while it runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-bg-"));
    const mgr = new BackgroundCommandManager({ outputDir: dir });

    const runRes = await bg(mgr)("echo one; sleep 0.3; echo two; sleep 5");
    const { id, output_path: outputPath } = JSON.parse(runRes.output) as {
      id: string;
      output_path: string;
    };
    expect(outputPath).toBe(join(dir, `${id}.log`));

    // Readable mid-flight — this is what replaces the old getBackgroundOutput.
    await waitFor(() => readFileSync(outputPath, "utf8").includes("one"));
    expect(mgr.get(id)?.status).toBe("running");
    await waitFor(() => readFileSync(outputPath, "utf8").includes("two"));

    // The file is cumulative — re-reading it never consumes anything.
    expect(readFileSync(outputPath, "utf8")).toContain("one");

    await killBackgroundTool(mgr).run({ id }, ctx);
  });

  it("records the exit reason in the log so the file is self-describing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-bg-"));
    const mgr = new BackgroundCommandManager({ outputDir: dir });

    const runRes = await bg(mgr)("echo boom; exit 3");
    const { id, output_path: outputPath } = JSON.parse(runRes.output) as {
      id: string;
      output_path: string;
    };

    await waitFor(() => mgr.get(id)?.status === "error");
    await waitFor(() => readFileSync(outputPath, "utf8").includes("exited with code 3"));
    expect(readFileSync(outputPath, "utf8")).toContain("boom");
  });

  it("omits output_path when the manager has no outputDir", async () => {
    const mgr = new BackgroundCommandManager();
    const runRes = await bg(mgr)("echo hi");
    expect(JSON.parse(runRes.output)).not.toHaveProperty("output_path");
    expect(mgr.get((JSON.parse(runRes.output) as { id: string }).id)?.outputPath).toBeUndefined();
  });
});

describe("killBackground", () => {
  it("terminates a running command and reports the error completion", async () => {
    const mgr = new BackgroundCommandManager();
    const killTool = killBackgroundTool(mgr);

    const completed: CommandRecord[] = [];
    mgr.onComplete((r) => completed.push(r));

    const runRes = await bg(mgr)("sleep 30");
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
    const mgr = new BackgroundCommandManager();
    const killTool = killBackgroundTool(mgr);

    const runRes = await bg(mgr)("echo hi");
    const { id } = JSON.parse(runRes.output) as { id: string };
    await waitFor(() => mgr.get(id)?.status === "completed");

    const killRes = await killTool.run({ id }, ctx);
    expect(killRes.isError).toBeUndefined();
    expect(JSON.parse(killRes.output)).toEqual({ id, status: "already-exited" });
  });

  it("reports an error for an unknown id", async () => {
    const mgr = new BackgroundCommandManager();
    const killTool = killBackgroundTool(mgr);

    const killRes = await killTool.run({ id: "nope" }, ctx);
    expect(killRes.isError).toBe(true);
    expect(killRes.output).toContain("no background command with id nope");
  });
});
