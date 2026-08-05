import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BackgroundCommandManager } from "./background/manager.js";
import { MonitorManager } from "./monitor/manager.js";

/**
 * Both managers run their commands through `/bin/bash -c`, so a pipeline leaves
 * the real work in grandchildren. Signalling only the shell used to leave those
 * alive holding the output pipe open — which orphaned them AND hung `disposeAll`
 * forever, because the spawn promise cannot settle while the stream is open.
 * These tests pin the process-group kill that fixes both halves.
 */
function alive(marker: string): number {
  try {
    return Number(execSync(`pgrep -f ${marker} | wc -l`).toString().trim());
  } catch {
    return 0;
  }
}

async function settle(ms = 700): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("process-group termination", () => {
  it("background disposeAll kills the whole pipeline and returns promptly", async () => {
    const marker = "NOVA_PGTEST_BG";
    const mgr = new BackgroundCommandManager();
    mgr.start({
      command: `tail -f /dev/null | grep --line-buffered ${marker}`,
      cwd: process.cwd(),
    });
    await settle(400);
    expect(alive(marker)).toBeGreaterThan(0);

    const started = Date.now();
    await mgr.disposeAll();
    // Must not wait on an unclosable pipe — the old bug never returned at all.
    expect(Date.now() - started).toBeLessThan(5000);
    await settle();
    expect(alive(marker)).toBe(0);
  }, 20_000);

  it("background kill() reaps grandchildren too", async () => {
    const marker = "NOVA_PGTEST_KILL";
    const mgr = new BackgroundCommandManager();
    const { id } = mgr.start({
      command: `tail -f /dev/null | grep --line-buffered ${marker}`,
      cwd: process.cwd(),
    });
    await settle(400);
    mgr.kill(id);
    await settle(900);
    expect(alive(marker)).toBe(0);
  }, 20_000);

  it("monitor disposeAll kills the whole pipeline and returns promptly", async () => {
    const marker = "NOVA_PGTEST_MON";
    const mgr = new MonitorManager();
    mgr.start({
      command: `tail -f /dev/null | grep --line-buffered ${marker}`,
      description: "pipeline watch",
      cwd: process.cwd(),
      persistent: true,
      timeoutMs: 0,
    });
    await settle(400);
    expect(alive(marker)).toBeGreaterThan(0);

    const started = Date.now();
    await mgr.disposeAll();
    expect(Date.now() - started).toBeLessThan(5000);
    await settle();
    expect(alive(marker)).toBe(0);
  }, 20_000);
});
