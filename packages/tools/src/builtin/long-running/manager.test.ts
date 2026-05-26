import { describe, expect, it } from "vitest";
import { LongRunningCommandError, LongRunningCommandManager } from "./manager.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("LongRunningCommandManager", () => {
  it("runs a command to completion and captures merged output", async () => {
    const mgr = new LongRunningCommandManager();
    const { id } = mgr.start({
      command: "echo hello && echo oops 1>&2",
      cwd: process.cwd(),
    });
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);

    await waitFor(() => mgr.get(id)?.status !== "running");
    const rec = mgr.get(id);
    expect(rec?.status).toBe("completed");
    expect(rec?.result).toContain("hello");
    expect(rec?.result).toContain("oops");
    expect(rec?.result).not.toContain("[truncated");
    expect(rec?.command).toBe("echo hello && echo oops 1>&2");
    expect(rec?.pid).toBeGreaterThan(0);
  });

  it("maps non-zero exits to error status with reason marker", async () => {
    const mgr = new LongRunningCommandManager();
    const { id } = mgr.start({ command: "exit 17", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");
    const rec = mgr.get(id);
    expect(rec?.status).toBe("error");
    expect(rec?.result).toContain("exited with code 17");
  });

  it("returns running status before the child exits", async () => {
    const mgr = new LongRunningCommandManager();
    const { id } = mgr.start({ command: "sleep 0.5", cwd: process.cwd() });
    expect(mgr.get(id)?.status).toBe("running");
    expect(mgr.get(id)?.pid).toBeGreaterThan(0);
    expect(mgr.get(id)?.result).toBeUndefined();
    await waitFor(() => mgr.get(id)?.status !== "running", 5000);
    expect(mgr.get(id)?.status).toBe("completed");
  });

  it("list() returns all records with only the public fields", async () => {
    const mgr = new LongRunningCommandManager();
    const a = mgr.start({ command: "echo a", cwd: process.cwd() });
    const b = mgr.start({ command: "echo b", cwd: process.cwd() });
    const records = mgr.list();
    expect(records.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    for (const r of records) {
      expect(Object.keys(r).sort()).toEqual(
        ["command", "id", "pid", "result", "status"]
          .filter((k) => k !== "result" || r.result !== undefined)
          .sort(),
      );
    }
  });

  it("rejects start() once the concurrent limit is reached", () => {
    const mgr = new LongRunningCommandManager({ maxConcurrent: 2 });
    mgr.start({ command: "sleep 1", cwd: process.cwd() });
    mgr.start({ command: "sleep 1", cwd: process.cwd() });
    expect(() => mgr.start({ command: "echo nope", cwd: process.cwd() })).toThrow(
      LongRunningCommandError,
    );
  });

  it("truncates the output buffer and prefixes a notice", async () => {
    const mgr = new LongRunningCommandManager({ bufferBytes: 1024 });
    const { id } = mgr.start({
      command: "head -c 8192 /dev/zero | tr '\\0' 'a'",
      cwd: process.cwd(),
    });
    await waitFor(() => mgr.get(id)?.status !== "running");
    const rec = mgr.get(id);
    expect(rec?.status).toBe("completed");
    expect(rec?.result).toMatch(/^\[truncated \d+ earlier bytes\]\n/);
    const match = rec!.result!.match(/^\[truncated (\d+) earlier bytes\]\n([\s\S]*)$/);
    expect(match).not.toBeNull();
    const truncated = Number(match![1]);
    const remaining = match![2]!.length;
    expect(remaining).toBeLessThanOrEqual(1024);
    expect(truncated + remaining).toBe(8192);
  });

  it("drainNotifications() yields ids of finished commands and clears the queue", async () => {
    const mgr = new LongRunningCommandManager();
    expect(mgr.drainNotifications()).toEqual([]);

    const a = mgr.start({ command: "echo a", cwd: process.cwd() });
    const b = mgr.start({ command: "exit 3", cwd: process.cwd() });
    await waitFor(
      () => mgr.get(a.id)?.status !== "running" && mgr.get(b.id)?.status !== "running",
    );

    const first = mgr.drainNotifications().sort();
    expect(first).toEqual([a.id, b.id].sort());
    expect(mgr.drainNotifications()).toEqual([]);

    const c = mgr.start({ command: "echo c", cwd: process.cwd() });
    await waitFor(() => mgr.get(c.id)?.status !== "running");
    expect(mgr.drainNotifications()).toEqual([c.id]);
  });

  it("disposeAll() terminates running children into error status", async () => {
    const mgr = new LongRunningCommandManager();
    const { id } = mgr.start({ command: "sleep 10", cwd: process.cwd() });
    expect(mgr.get(id)?.status).toBe("running");
    await mgr.disposeAll();
    const rec = mgr.get(id);
    expect(rec?.status).toBe("error");
    expect(rec?.result).toContain("SIGTERM");
  });
});
