import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackgroundCommandError, BackgroundCommandManager } from "./manager.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("BackgroundCommandManager", () => {
  it("runs a command to completion and captures merged output", async () => {
    const mgr = new BackgroundCommandManager();
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
    const mgr = new BackgroundCommandManager();
    const { id } = mgr.start({ command: "exit 17", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");
    const rec = mgr.get(id);
    expect(rec?.status).toBe("error");
    expect(rec?.result).toContain("exited with code 17");
  });

  it("returns running status before the child exits", async () => {
    const mgr = new BackgroundCommandManager();
    const { id } = mgr.start({ command: "sleep 0.5", cwd: process.cwd() });
    expect(mgr.get(id)?.status).toBe("running");
    expect(mgr.get(id)?.pid).toBeGreaterThan(0);
    expect(mgr.get(id)?.result).toBeUndefined();
    await waitFor(() => mgr.get(id)?.status !== "running", 5000);
    expect(mgr.get(id)?.status).toBe("completed");
  });

  it("list() returns all records with only the public fields", async () => {
    const mgr = new BackgroundCommandManager();
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
    const mgr = new BackgroundCommandManager({ maxConcurrent: 2 });
    mgr.start({ command: "sleep 1", cwd: process.cwd() });
    mgr.start({ command: "sleep 1", cwd: process.cwd() });
    expect(() => mgr.start({ command: "echo nope", cwd: process.cwd() })).toThrow(
      BackgroundCommandError,
    );
  });

  it("truncates the output buffer and prefixes a notice", async () => {
    const mgr = new BackgroundCommandManager({ bufferBytes: 1024 });
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
    const mgr = new BackgroundCommandManager();
    expect(mgr.drainNotifications()).toEqual([]);

    const a = mgr.start({ command: "echo a", cwd: process.cwd() });
    const b = mgr.start({ command: "exit 3", cwd: process.cwd() });
    await waitFor(() => mgr.get(a.id)?.status !== "running" && mgr.get(b.id)?.status !== "running");

    const first = mgr.drainNotifications().sort();
    expect(first).toEqual([a.id, b.id].sort());
    expect(mgr.drainNotifications()).toEqual([]);

    const c = mgr.start({ command: "echo c", cwd: process.cwd() });
    await waitFor(() => mgr.get(c.id)?.status !== "running");
    expect(mgr.drainNotifications()).toEqual([c.id]);
  });

  it("completionNotice() points at the log file instead of carrying the output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-mgr-"));
    const mgr = new BackgroundCommandManager({ outputDir: dir });
    const { id } = mgr.start({ command: "echo hello", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");

    const notice = mgr.completionNotice(id);
    expect(notice?.status).toBe("completed");
    expect(notice?.outputPath).toBe(join(dir, `${id}.log`));
    // The output lives in the file, NOT in the notice — one delivery channel.
    expect(notice?.inlineOutput).toBeUndefined();
    expect(readFileSync(notice!.outputPath!, "utf8")).toContain("hello");
  });

  it("completionNotice() is repeatable — nothing is consumed by reading it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-mgr-"));
    const mgr = new BackgroundCommandManager({ outputDir: dir });
    const { id } = mgr.start({ command: "echo hello", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");

    expect(mgr.completionNotice(id)).toEqual(mgr.completionNotice(id));
  });

  it("completionNotice() carries the exit reason for a failed command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-mgr-"));
    const mgr = new BackgroundCommandManager({ outputDir: dir });
    const { id } = mgr.start({ command: "echo boom; exit 9", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");

    const notice = mgr.completionNotice(id);
    expect(notice?.status).toBe("error");
    expect(notice?.reason).toBe("exited with code 9");
  });

  it("completionNotice() inlines the output only when there is no log file", async () => {
    // Degraded config (no outputDir): with nothing to point at, the notice
    // becomes the single channel rather than a second one.
    const mgr = new BackgroundCommandManager();
    const { id } = mgr.start({ command: "echo hello", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");

    const notice = mgr.completionNotice(id);
    expect(notice?.outputPath).toBeUndefined();
    expect(notice?.inlineOutput).toContain("hello");
  });

  it("completionNotice() returns undefined for an unknown id", () => {
    const mgr = new BackgroundCommandManager();
    expect(mgr.completionNotice("nope")).toBeUndefined();
  });

  it("peek() snapshots output non-destructively, for the /tasks panel", async () => {
    const mgr = new BackgroundCommandManager();
    const { id } = mgr.start({ command: "echo hello", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");

    const first = mgr.peek(id);
    expect(first.output).toContain("hello");
    expect(first.status).toBe("completed");
    // A second peek still sees the same output — non-consuming.
    expect(mgr.peek(id).output).toBe(first.output);
  });

  it("peek() throws on an unknown id", () => {
    const mgr = new BackgroundCommandManager();
    expect(() => mgr.peek("nope")).toThrow(BackgroundCommandError);
  });

  it("records `label` as the display command while executing `command`", async () => {
    const mgr = new BackgroundCommandManager();
    // `command` is a wrapped form; `label` is what the user/model asked for.
    const { id } = mgr.start({
      command: "/bin/echo wrapped-ran",
      label: "echo original",
      cwd: process.cwd(),
    });
    expect(mgr.get(id)?.command).toBe("echo original");
    expect(mgr.peek(id).command).toBe("echo original");
    await waitFor(() => mgr.get(id)?.status !== "running");
    // The wrapped command is the one that actually executed.
    expect(mgr.get(id)?.result).toContain("wrapped-ran");
    // …but the display command is unchanged after completion.
    expect(mgr.get(id)?.command).toBe("echo original");
  });

  it("disposeAll() terminates running children into error status", async () => {
    const mgr = new BackgroundCommandManager();
    const { id } = mgr.start({ command: "sleep 10", cwd: process.cwd() });
    expect(mgr.get(id)?.status).toBe("running");
    await mgr.disposeAll();
    const rec = mgr.get(id);
    expect(rec?.status).toBe("error");
    expect(rec?.result).toContain("SIGTERM");
  });
});
