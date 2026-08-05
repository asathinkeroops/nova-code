import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MonitorError, MonitorManager } from "./manager.js";

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function startIn(
  mgr: MonitorManager,
  command: string,
  over: Partial<{ persistent: boolean }> = {},
) {
  return mgr.start({
    command,
    description: "test watch",
    cwd: process.cwd(),
    persistent: over.persistent ?? false,
    timeoutMs: 30_000,
  });
}

/** All event lines a monitor has produced so far, draining as it goes. */
function drainLines(mgr: MonitorManager, id: string, into: string[]): void {
  for (const pendingId of mgr.drainPending()) {
    const ev = mgr.takeEvents(pendingId);
    if (ev && pendingId === id) into.push(...ev.lines);
  }
}

describe("MonitorManager events", () => {
  it("turns each stdout line into an event", async () => {
    const mgr = new MonitorManager();
    const { id } = startIn(mgr, "printf 'a\\nb\\nc\\n'");

    const lines: string[] = [];
    await waitFor(() => {
      drainLines(mgr, id, lines);
      return lines.length >= 3;
    });
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("reassembles lines split across chunk boundaries", async () => {
    const mgr = new MonitorManager();
    // Two writes with no newline until the end — one logical line.
    const { id } = startIn(mgr, "printf 'AAA'; sleep 0.2; printf 'BBB\\n'");

    const lines: string[] = [];
    await waitFor(() => {
      drainLines(mgr, id, lines);
      return lines.length >= 1;
    });
    expect(lines).toEqual(["AAABBB"]);
  });

  it("emits a trailing line that never got its newline", async () => {
    const mgr = new MonitorManager();
    const { id } = startIn(mgr, "printf 'no-newline-here'");

    await waitFor(() => mgr.get(id)?.status === "exited");
    const lines: string[] = [];
    drainLines(mgr, id, lines);
    expect(lines).toContain("no-newline-here");
  });

  it("does not turn stderr into events, but does log it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-mon-"));
    const mgr = new MonitorManager({ outputDir: dir });
    const rec = startIn(mgr, "echo to-stdout; echo to-stderr >&2");

    await waitFor(() => mgr.get(rec.id)?.status === "exited");
    const lines: string[] = [];
    drainLines(mgr, rec.id, lines);
    expect(lines).toContain("to-stdout");
    expect(lines).not.toContain("to-stderr");

    // Both streams are in the log, so stderr is retrievable with `read`.
    const log = readFileSync(rec.outputPath!, "utf8");
    expect(log).toContain("to-stdout");
    expect(log).toContain("to-stderr");
  });

  it("delivers each event exactly once (takeEvents consumes)", async () => {
    const mgr = new MonitorManager();
    const { id } = startIn(mgr, "printf 'once\\n'");

    await waitFor(() => mgr.hasPending());
    mgr.drainPending();
    expect(mgr.takeEvents(id)?.lines).toEqual(["once"]);
    // Re-taking yields nothing — the events have no second delivery channel,
    // so the queue must hand each line over exactly once.
    expect(mgr.takeEvents(id)).toBeUndefined();
  });
});

describe("MonitorManager limits", () => {
  it("kills a monitor that floods, and says why", async () => {
    const mgr = new MonitorManager({ maxEventsPerWindow: 5, windowMs: 60_000 });
    const { id } = startIn(mgr, "for i in $(seq 1 200); do echo line-$i; done; sleep 5");

    await waitFor(() => mgr.get(id)?.status === "flooded");
    expect(mgr.get(id)?.reason).toContain("exceeding 5 events");
    // Killed, not throttled: the script would have printed 200 lines and then
    // slept, so a throttled monitor would keep climbing. Give it time to prove
    // it doesn't.
    const at = mgr.get(id)!.eventCount;
    expect(at).toBeLessThan(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(mgr.get(id)?.eventCount).toBe(at);
  });

  it("caps the undrained queue by dropping the OLDEST events", async () => {
    const mgr = new MonitorManager({ maxQueuedEvents: 3, maxEventsPerWindow: 1000 });
    const { id } = startIn(mgr, "for i in 1 2 3 4 5 6; do echo line-$i; done");

    await waitFor(() => mgr.get(id)?.status === "exited");
    mgr.drainPending();
    const ev = mgr.takeEvents(id);
    expect(ev?.lines).toEqual(["line-4", "line-5", "line-6"]);
    expect(ev?.droppedEvents).toBe(3);
  });

  it("truncates an absurdly long single line", async () => {
    const mgr = new MonitorManager({ maxLineBytes: 20 });
    const { id } = startIn(mgr, "printf 'x%.0s' $(seq 1 200); printf '\\n'");

    await waitFor(() => mgr.get(id)?.status === "exited");
    mgr.drainPending();
    const line = mgr.takeEvents(id)?.lines[0] ?? "";
    expect(line.startsWith("x".repeat(20))).toBe(true);
    expect(line).toContain("truncated 180 chars");
  });

  it("refuses to start past the concurrency cap", () => {
    const mgr = new MonitorManager({ maxConcurrent: 1 });
    startIn(mgr, "sleep 5");
    expect(() => startIn(mgr, "sleep 5")).toThrow(MonitorError);
  });

  it("stops a non-persistent monitor at its deadline", async () => {
    const mgr = new MonitorManager();
    const { id } = mgr.start({
      command: "sleep 30",
      description: "deadline test",
      cwd: process.cwd(),
      persistent: false,
      timeoutMs: 150,
    });

    await waitFor(() => mgr.get(id)?.status === "timeout");
    expect(mgr.get(id)?.reason).toContain("deadline");
  });

  it("gives a persistent monitor no deadline", async () => {
    const mgr = new MonitorManager();
    const { id } = mgr.start({
      command: "sleep 30",
      description: "persistent test",
      cwd: process.cwd(),
      persistent: true,
      timeoutMs: 100,
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(mgr.get(id)?.status).toBe("running");
    await mgr.disposeAll();
  });
});

describe("MonitorManager lifecycle", () => {
  it("announces a terminal transition so silence is never ambiguous", async () => {
    const mgr = new MonitorManager();
    const { id } = startIn(mgr, "echo tick; exit 4");

    await waitFor(() => mgr.get(id)?.status === "exited");
    mgr.drainPending();
    const ev = mgr.takeEvents(id);
    expect(ev?.lines).toEqual(["tick"]);
    expect(ev?.status).toBe("exited");
    expect(ev?.reason).toContain("exited with code 4");
  });

  it("stop() terminates a running watch and reports the request as the cause", async () => {
    const mgr = new MonitorManager();
    const { id } = startIn(mgr, "sleep 30");
    await waitFor(() => mgr.get(id)?.status === "running");

    expect(mgr.stop(id)).toEqual({ id, description: "test watch", alreadyStopped: false });
    await waitFor(() => mgr.get(id)?.status === "stopped");
    // The kill is the CONSEQUENCE of the stop, so `stopped` must not be
    // overwritten by the exit handler's signal reason.
    expect(mgr.get(id)?.reason).toBe("stopped by request");
  });

  it("announces a kill immediately, and exactly once", async () => {
    const mgr = new MonitorManager();
    // `trap ''` makes the script ignore SIGTERM, so the kill takes the full
    // SIGKILL escalation — the window in which the model must NOT still think
    // the watch is live.
    const { id } = startIn(mgr, "trap '' TERM; sleep 30");
    await waitFor(() => mgr.get(id)?.status === "running");

    mgr.stop(id);
    mgr.drainPending();
    const first = mgr.takeEvents(id);
    expect(first?.status).toBe("stopped");

    // The process is still dying; when it does, that must not announce again.
    await waitFor(() => mgr.get(id)?.status === "stopped" && !mgr.get(id)?.persistent);
    await new Promise((r) => setTimeout(r, 2000));
    mgr.drainPending();
    expect(mgr.takeEvents(id)).toBeUndefined();
  }, 10_000);

  it("stop() is a no-op for a finished watch and throws on an unknown id", async () => {
    const mgr = new MonitorManager();
    const { id } = startIn(mgr, "echo hi");
    await waitFor(() => mgr.get(id)?.status === "exited");

    expect(mgr.stop(id).alreadyStopped).toBe(true);
    expect(() => mgr.stop("nope")).toThrow(MonitorError);
  });

  it("fires onEvents so an idle agent can be woken", async () => {
    const mgr = new MonitorManager();
    const woken: string[] = [];
    mgr.onEvents((id) => woken.push(id));

    const { id } = startIn(mgr, "echo wake-me");
    await waitFor(() => woken.length > 0);
    expect(woken[0]).toBe(id);
  });

  it("disposeAll stops everything still running", async () => {
    const mgr = new MonitorManager();
    const a = startIn(mgr, "sleep 30", { persistent: true });
    const b = startIn(mgr, "sleep 30");

    await waitFor(() => mgr.get(a.id)?.status === "running" && mgr.get(b.id)?.status === "running");
    await mgr.disposeAll();
    expect(mgr.get(a.id)?.status).toBe("stopped");
    expect(mgr.get(b.id)?.status).toBe("stopped");
  });
});
