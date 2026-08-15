import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, openSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { execa, type ExecaError, type ResultPromise } from "execa";
import { DETACHED_SPAWN, awaitBounded, terminateGroup } from "../process-group.js";

/**
 * Why a monitor is no longer running.
 *
 * - `exited`  — the script ended on its own (the normal end of a bounded watch)
 * - `stopped` — stopMonitor / session dispose terminated it
 * - `timeout` — its `timeoutMs` deadline elapsed (non-persistent monitors only)
 * - `flooded` — it produced events faster than `maxEventsPerWindow` allows and
 *               was killed to protect the context window
 * - `failed`  — it could not be spawned at all
 */
export type MonitorStatus = "running" | "exited" | "stopped" | "timeout" | "flooded" | "failed";

export interface MonitorRecord {
  id: string;
  pid: number;
  command: string;
  /** Human label echoed in every notification, so events say what they are. */
  description: string;
  status: MonitorStatus;
  persistent: boolean;
  /** Total events emitted since start (not just the undrained ones). */
  eventCount: number;
  /** Absolute path of the combined stdout+stderr log, when an outputDir is set. */
  outputPath?: string;
  /** Explanation for a non-`exited` terminal status, and for a non-zero exit. */
  reason?: string;
}

export interface StartMonitorInput {
  command: string;
  description: string;
  cwd: string;
  persistent: boolean;
  /** Deadline in ms; ignored when `persistent`. */
  timeoutMs: number;
  env?: Record<string, string>;
  /**
   * Human-facing command recorded for display. When the caller wraps `command`
   * for execution (a sandbox prefix), pass the original here. Defaults to
   * `command`.
   */
  label?: string;
}

export interface MonitorOptions {
  maxConcurrent?: number;
  /** Events allowed per {@link windowMs} before a monitor is killed as a flood. */
  maxEventsPerWindow?: number;
  windowMs?: number;
  /** Cap on undrained events; overflow drops the OLDEST and is reported. */
  maxQueuedEvents?: number;
  /** Single-line cap; a longer line is truncated with a marker. */
  maxLineBytes?: number;
  /** Directory for per-monitor `{id}.log` files (stdout AND stderr). */
  outputDir?: string;
}

/** One batch of events, as handed to the notifier. */
export interface MonitorEvents {
  id: string;
  description: string;
  command: string;
  lines: string[];
  /** Events discarded because the undrained queue hit its cap. */
  droppedEvents: number;
  /**
   * Set when the monitor reached a terminal state in this batch — the notifier
   * renders it so the model learns the watch is over rather than assuming
   * silence means "still watching".
   */
  status?: MonitorStatus;
  reason?: string;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_EVENTS_PER_WINDOW = 60;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_QUEUED_EVENTS = 200;
const DEFAULT_MAX_LINE_BYTES = 2_000;
export class MonitorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorError";
  }
}

interface InternalMonitor extends MonitorRecord {
  child?: ResultPromise;
  lifecycle?: Promise<void>;
  sink?: WriteStream;
  /** Undrained event lines awaiting the next request. */
  queue: string[];
  droppedEvents: number;
  /** Partial trailing line from the last stdout chunk (no newline yet). */
  partial: string;
  /** Sliding flood window: start timestamp and the count within it. */
  windowStart: number;
  windowCount: number;
  timeoutTimer?: NodeJS.Timeout;
  /** Terminal transition not yet announced to the model. */
  pendingTerminal?: { status: MonitorStatus; reason?: string };
}

function generateId(): string {
  return randomBytes(6).toString("base64url");
}

function publicView(m: InternalMonitor): MonitorRecord {
  const view: MonitorRecord = {
    id: m.id,
    pid: m.pid,
    command: m.command,
    description: m.description,
    status: m.status,
    persistent: m.persistent,
    eventCount: m.eventCount,
  };
  if (m.outputPath !== undefined) view.outputPath = m.outputPath;
  if (m.reason !== undefined) view.reason = m.reason;
  return view;
}

/** Event name carrying a monitor id whose queue just became non-empty. */
const EVENT_READY = "events";

/**
 * Runs watch scripts whose **stdout lines are events**. Where
 * `BackgroundCommandManager` announces once, on exit, this announces per line —
 * the difference that makes `tail -f`, `inotifywait -m`, and poll loops useful
 * to an agent instead of something it has to remember to go look at.
 *
 * stdout is the event stream; stderr goes to the log file only. That split is
 * deliberate: it lets a script emit events on stdout while its diagnostics stay
 * out of the model's context, retrievable with `read` when something looks off.
 */
export class MonitorManager extends EventEmitter {
  private readonly monitors = new Map<string, InternalMonitor>();
  private readonly maxConcurrent: number;
  private readonly maxEventsPerWindow: number;
  private readonly windowMs: number;
  private readonly maxQueuedEvents: number;
  private readonly maxLineBytes: number;
  private readonly outputDir: string | undefined;
  private outputDirReady = false;
  /** Ids with undrained events or an unannounced terminal transition. */
  private readonly pending = new Set<string>();

  constructor(opts: MonitorOptions = {}) {
    super();
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxEventsPerWindow = opts.maxEventsPerWindow ?? DEFAULT_MAX_EVENTS_PER_WINDOW;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxQueuedEvents = opts.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS;
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.outputDir = opts.outputDir;
  }

  /**
   * Subscribe to "this monitor has something to say" — the push signal the CLI
   * listens on to wake an idle agent. Returns an unsubscribe function.
   */
  onEvents(listener: (id: string) => void): () => void {
    this.on(EVENT_READY, listener);
    return () => {
      this.off(EVENT_READY, listener);
    };
  }

  private openSink(id: string): { path: string; stream: WriteStream } | undefined {
    if (this.outputDir === undefined) return undefined;
    try {
      if (!this.outputDirReady) {
        mkdirSync(this.outputDir, { recursive: true });
        this.outputDirReady = true;
      }
      const path = join(this.outputDir, `${id}.log`);
      // Synchronous open so the path is readable the moment `start` returns.
      const stream = createWriteStream(path, { fd: openSync(path, "a") });
      stream.on("error", () => {});
      return { path, stream };
    } catch {
      return undefined;
    }
  }

  /** Queue one event line, applying the per-line cap and the queue cap. */
  private enqueue(m: InternalMonitor, line: string): void {
    let text = line;
    if (text.length > this.maxLineBytes) {
      text = `${text.slice(0, this.maxLineBytes)}…(truncated ${text.length - this.maxLineBytes} chars)`;
    }
    m.queue.push(text);
    m.eventCount += 1;
    // Overflow drops the OLDEST: when a watch outruns the agent, the newest
    // events are the ones worth keeping (a crash marker beats stale progress).
    while (m.queue.length > this.maxQueuedEvents) {
      m.queue.shift();
      m.droppedEvents += 1;
    }
    this.markPending(m.id);
  }

  private markPending(id: string): void {
    const wasEmpty = !this.pending.has(id);
    this.pending.add(id);
    if (wasEmpty) this.emit(EVENT_READY, id);
  }

  /**
   * Count an event against the flood window; returns false once the monitor has
   * exceeded its budget, which the caller turns into a kill. Silently dropping
   * the excess instead would leave a runaway watch burning CPU forever with the
   * model none the wiser.
   */
  private withinRate(m: InternalMonitor, now: number): boolean {
    if (now - m.windowStart >= this.windowMs) {
      m.windowStart = now;
      m.windowCount = 0;
    }
    m.windowCount += 1;
    return m.windowCount <= this.maxEventsPerWindow;
  }

  /** Split a stdout chunk into complete lines, carrying any partial tail over. */
  private consumeStdout(m: InternalMonitor, chunk: Buffer): void {
    const text = m.partial + chunk.toString("utf8");
    const parts = text.split("\n");
    // The last element is the (possibly empty) partial line after the final \n.
    m.partial = parts.pop() ?? "";
    for (const raw of parts) {
      const line = raw.replace(/\r$/, "");
      if (line.length === 0) continue;
      if (m.status !== "running") return;
      if (!this.withinRate(m, Date.now())) {
        this.terminate(
          m,
          "flooded",
          `stopped after exceeding ${this.maxEventsPerWindow} events per ` +
            `${Math.round(this.windowMs / 1000)}s — narrow the filter and start a new monitor`,
        );
        return;
      }
      this.enqueue(m, line);
    }
  }

  start(input: StartMonitorInput): MonitorRecord {
    const running = [...this.monitors.values()].filter((m) => m.status === "running");
    if (running.length >= this.maxConcurrent) {
      throw new MonitorError(
        `monitor limit reached (${this.maxConcurrent}); stop one before starting another`,
      );
    }

    let id = generateId();
    while (this.monitors.has(id)) id = generateId();

    const displayCommand = input.label ?? input.command;
    const env = input.env ? { ...process.env, ...input.env } : undefined;
    const sink = this.openSink(id);

    const m: InternalMonitor = {
      id,
      pid: -1,
      command: displayCommand,
      description: input.description,
      status: "running",
      persistent: input.persistent,
      eventCount: 0,
      queue: [],
      droppedEvents: 0,
      partial: "",
      windowStart: Date.now(),
      windowCount: 0,
      ...(sink ? { outputPath: sink.path, sink: sink.stream } : {}),
    };
    this.monitors.set(id, m);

    let child: ResultPromise;
    try {
      child = execa(input.command, {
        shell: "/bin/bash",
        cwd: input.cwd,
        ...(env ? { env } : {}),
        reject: false,
        buffer: false,
        // Own process group, so the whole pipeline can be signalled at once —
        // see process-group.ts. Without it a `tail -f | grep` outlives its shell.
        ...DETACHED_SPAWN,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      m.sink?.end(`[failed to start: ${msg}]\n`);
      m.sink = undefined;
      m.status = "failed";
      m.reason = msg;
      m.pendingTerminal = { status: "failed", reason: msg };
      this.markPending(id);
      return publicView(m);
    }

    m.child = child;
    m.pid = child.pid ?? -1;

    // stdout is the event stream; stderr is diagnostics for the log only.
    child.stdout?.on("data", (chunk: Buffer) => {
      m.sink?.write(chunk);
      this.consumeStdout(m, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      m.sink?.write(chunk);
    });

    if (!input.persistent && input.timeoutMs > 0) {
      m.timeoutTimer = setTimeout(() => {
        this.terminate(m, "timeout", `watch deadline of ${input.timeoutMs}ms elapsed`);
      }, input.timeoutMs);
      m.timeoutTimer.unref?.();
    }

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (m.timeoutTimer) clearTimeout(m.timeoutTimer);
      m.timeoutTimer = undefined;
      // A trailing line with no newline is still an event.
      if (m.partial.trim().length > 0 && m.status === "running") {
        this.enqueue(m, m.partial.replace(/\r$/, ""));
      }
      m.partial = "";
      m.sink?.end();
      m.sink = undefined;
      m.child = undefined;
      // Only a NATURAL exit is announced here. When terminate() already set a
      // status (stopped/timeout/flooded) it also already queued the
      // announcement — the process dying is the consequence of that decision,
      // not a second outcome, and re-queueing would announce it twice. It also
      // must not wait for the exit: SIGTERM→SIGKILL can take 1.5s, and during
      // that window the model would still believe the watch was live.
      if (m.status !== "running") return;
      const reason =
        signal !== null
          ? `terminated by signal ${signal}`
          : exitCode !== null && exitCode !== 0
            ? `script exited with code ${exitCode}`
            : undefined;
      m.status = "exited";
      if (reason !== undefined) m.reason = reason;
      m.pendingTerminal = { status: "exited", ...(reason !== undefined ? { reason } : {}) };
      this.markPending(m.id);
    };

    m.lifecycle = child.then(
      (res) => settle(res.exitCode ?? null, (res.signal ?? null) as NodeJS.Signals | null),
      (err: ExecaError) =>
        settle(err.exitCode ?? null, (err.signal ?? null) as NodeJS.Signals | null),
    );

    return publicView(m);
  }

  /**
   * Mark a terminal status, announce it immediately, then kill the child.
   *
   * The announcement does NOT wait for the process to die: escalating
   * SIGTERM→SIGKILL can take {@link DISPOSE_SIGKILL_DELAY_MS}, and a watch the
   * model still believes is live is exactly the ambiguity monitors exist to
   * remove. `settle` therefore skips announcing when it finds a non-`running`
   * status here.
   */
  private terminate(m: InternalMonitor, status: MonitorStatus, reason: string): void {
    if (m.status !== "running") return;
    m.status = status;
    m.reason = reason;
    m.pendingTerminal = { status, reason };
    this.markPending(m.id);
    const child = m.child;
    if (!child) return;
    const cancelEscalation = terminateGroup(child.pid);
    void (m.lifecycle ?? Promise.resolve()).finally(cancelEscalation);
  }

  /** Stop a monitor by id. Throws on an unknown id. */
  stop(id: string): { id: string; description: string; alreadyStopped: boolean } {
    const m = this.monitors.get(id);
    if (!m) throw new MonitorError(`no monitor with id ${id}`);
    if (m.status !== "running") {
      return { id: m.id, description: m.description, alreadyStopped: true };
    }
    this.terminate(m, "stopped", "stopped by request");
    return { id: m.id, description: m.description, alreadyStopped: false };
  }

  /** Ids with undrained events or an unannounced terminal transition. */
  drainPending(): string[] {
    const out = [...this.pending];
    this.pending.clear();
    return out;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Take one monitor's queued events. Consuming here is correct — unlike a
   * background command's output there is no file the model can re-read events
   * from, so this queue IS the single delivery channel and each event must be
   * handed over exactly once.
   */
  takeEvents(id: string): MonitorEvents | undefined {
    const m = this.monitors.get(id);
    if (!m) return undefined;
    const lines = m.queue;
    const droppedEvents = m.droppedEvents;
    const terminal = m.pendingTerminal;
    m.queue = [];
    m.droppedEvents = 0;
    m.pendingTerminal = undefined;
    if (lines.length === 0 && droppedEvents === 0 && !terminal) return undefined;
    return {
      id: m.id,
      description: m.description,
      command: m.command,
      lines,
      droppedEvents,
      ...(terminal ? { status: terminal.status } : {}),
      ...(terminal?.reason !== undefined ? { reason: terminal.reason } : {}),
    };
  }

  get(id: string): MonitorRecord | undefined {
    const m = this.monitors.get(id);
    return m ? publicView(m) : undefined;
  }

  list(): MonitorRecord[] {
    return [...this.monitors.values()].map(publicView);
  }

  async disposeAll(): Promise<void> {
    const running = [...this.monitors.values()].filter((m) => m.status === "running" && m.child);
    if (running.length === 0) return;
    for (const m of running) this.terminate(m, "stopped", "session ended");
    // Bounded: terminate() already armed the SIGKILL escalation, so anything
    // still alive past the cap is genuinely unkillable — don't wedge exit on it.
    await awaitBounded(running.map((m) => m.lifecycle ?? Promise.resolve()));
  }
}
