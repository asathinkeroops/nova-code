import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { execa, type ExecaError, type ResultPromise } from "execa";

export type CommandStatus = "running" | "completed" | "error";

export interface CommandRecord {
  id: string;
  pid: number;
  command: string;
  status: CommandStatus;
  result?: string;
}

export interface StartInput {
  command: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface ManagerOptions {
  bufferBytes?: number;
  maxConcurrent?: number;
}

export interface KillResult {
  id: string;
  command: string;
  /** True when the command had already finished, so the kill was a no-op. */
  alreadyExited: boolean;
}

export interface ReadResult {
  id: string;
  command: string;
  status: CommandStatus;
  /** New output produced since the previous read (this read consumes it). */
  output: string;
  /** Bytes that scrolled out of the ring buffer before this read saw them. */
  droppedBytes: number;
}

const DEFAULT_BUFFER_BYTES = 1_000_000;
const DEFAULT_MAX_CONCURRENT = 8;
const DISPOSE_SIGKILL_DELAY_MS = 1500;

export class LongRunningCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongRunningCommandError";
  }
}

interface OutputBuffer {
  chunks: Buffer[];
  bytes: number;
  truncated: number;
}

interface InternalRecord extends CommandRecord {
  buf: OutputBuffer;
  child?: ResultPromise;
  lifecycle?: Promise<void>;
  /** Total produced-bytes already returned by `read` (incremental cursor). */
  readCursor: number;
  /** Exit/termination marker (unbracketed) for error completions, if any. */
  reason?: string;
}

function generateId(): string {
  return randomBytes(6).toString("base64url");
}

function publicView(r: InternalRecord): CommandRecord {
  const view: CommandRecord = {
    id: r.id,
    pid: r.pid,
    command: r.command,
    status: r.status,
  };
  if (r.result !== undefined) view.result = r.result;
  return view;
}

function appendChunk(buf: OutputBuffer, chunk: Buffer, cap: number): void {
  if (chunk.length >= cap) {
    buf.truncated += buf.bytes + (chunk.length - cap);
    buf.chunks = [chunk.subarray(chunk.length - cap)];
    buf.bytes = cap;
    return;
  }
  buf.chunks.push(chunk);
  buf.bytes += chunk.length;
  while (buf.bytes > cap && buf.chunks.length > 1) {
    const head = buf.chunks.shift() as Buffer;
    buf.bytes -= head.length;
    buf.truncated += head.length;
  }
  if (buf.bytes > cap && buf.chunks.length === 1) {
    const only = buf.chunks[0] as Buffer;
    const overflow = buf.bytes - cap;
    buf.chunks[0] = only.subarray(overflow);
    buf.bytes -= overflow;
    buf.truncated += overflow;
  }
}

function renderOutput(buf: OutputBuffer): string {
  const text = Buffer.concat(buf.chunks).toString("utf8");
  if (buf.truncated > 0) {
    return `[truncated ${buf.truncated} earlier bytes]\n${text}`;
  }
  return text;
}

function finalize(
  buf: OutputBuffer,
  signal: NodeJS.Signals | null,
  exitCode: number | null,
  errMsg: string | undefined,
): { status: CommandStatus; result: string; reason?: string } {
  const output = renderOutput(buf);
  const isError = !!signal || !!errMsg || (exitCode !== null && exitCode !== 0);
  if (!isError) {
    return { status: "completed", result: output };
  }
  const reason = errMsg
    ? errMsg
    : signal
      ? `terminated by signal ${signal}`
      : `exited with code ${exitCode}`;
  const result = output ? `${output}\n[${reason}]` : `[${reason}]`;
  return { status: "error", result, reason };
}

/** Event name carrying a finished command's public record. */
const COMPLETE_EVENT = "complete";

export class LongRunningCommandManager extends EventEmitter {
  private readonly records = new Map<string, InternalRecord>();
  private readonly completedIds: string[] = [];
  private readonly bufferBytes: number;
  private readonly maxConcurrent: number;

  constructor(opts: ManagerOptions = {}) {
    super();
    this.bufferBytes = opts.bufferBytes ?? DEFAULT_BUFFER_BYTES;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Subscribe to command completions (success or failure) — the push signal the
   * CLI listens on to wake an idle agent. Returns an unsubscribe function.
   */
  onComplete(listener: (record: CommandRecord) => void): () => void {
    this.on(COMPLETE_EVENT, listener);
    return () => {
      this.off(COMPLETE_EVENT, listener);
    };
  }

  /** Mark a finished command: queue it for the notifier and emit `complete`. */
  private markComplete(record: InternalRecord): void {
    this.completedIds.push(record.id);
    this.emit(COMPLETE_EVENT, publicView(record));
  }

  start(input: StartInput): { id: string; pid: number } {
    const running = Array.from(this.records.values()).filter(
      (r) => r.status === "running",
    );
    if (running.length >= this.maxConcurrent) {
      throw new LongRunningCommandError(
        `concurrent command limit reached (${this.maxConcurrent}); wait for some to finish`,
      );
    }

    let id = generateId();
    while (this.records.has(id)) id = generateId();

    const env = input.env ? { ...process.env, ...input.env } : undefined;
    const buf: OutputBuffer = { chunks: [], bytes: 0, truncated: 0 };

    let child: ResultPromise;
    try {
      child = execa(input.command, {
        shell: "/bin/bash",
        cwd: input.cwd,
        ...(env ? { env } : {}),
        all: true,
        reject: false,
        buffer: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const { status, result, reason } = finalize(buf, null, null, msg);
      const record: InternalRecord = {
        id,
        pid: -1,
        command: input.command,
        status,
        result,
        buf,
        readCursor: 0,
        ...(reason !== undefined ? { reason } : {}),
      };
      this.records.set(id, record);
      this.markComplete(record);
      return { id, pid: record.pid };
    }

    const cap = this.bufferBytes;
    child.all?.on("data", (chunk: Buffer) => appendChunk(buf, chunk, cap));

    const record: InternalRecord = {
      id,
      pid: child.pid ?? -1,
      command: input.command,
      status: "running",
      buf,
      child,
      readCursor: 0,
    };
    this.records.set(id, record);

    record.lifecycle = child.then(
      (res) => {
        const signal = (res.signal ?? null) as NodeJS.Signals | null;
        const exitCode = res.exitCode ?? null;
        const { status, result, reason } = finalize(buf, signal, exitCode, undefined);
        record.status = status;
        record.result = result;
        if (reason !== undefined) record.reason = reason;
        record.child = undefined;
        this.markComplete(record);
      },
      (err: ExecaError) => {
        const signal = (err.signal ?? null) as NodeJS.Signals | null;
        const exitCode = err.exitCode ?? null;
        const msg = err.shortMessage ?? err.message ?? String(err);
        const { status, result, reason } = finalize(buf, signal, exitCode, msg);
        record.status = status;
        record.result = result;
        if (reason !== undefined) record.reason = reason;
        record.child = undefined;
        this.markComplete(record);
      },
    );

    return { id, pid: record.pid };
  }

  /**
   * Terminate a running command by id (SIGTERM, escalating to SIGKILL). The
   * child's lifecycle handler still fires on exit, so the terminated output is
   * delivered through the normal completion path. Throws if the id is unknown;
   * a no-op (with `alreadyExited: true`) if the command already finished.
   */
  kill(id: string): KillResult {
    const r = this.records.get(id);
    if (!r) {
      throw new LongRunningCommandError(`no background command with id ${id}`);
    }
    if (r.status !== "running" || !r.child) {
      return { id: r.id, command: r.command, alreadyExited: true };
    }

    const child = r.child;
    try {
      child.kill("SIGTERM");
    } catch {
      // best-effort
    }

    const sigkillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }, DISPOSE_SIGKILL_DELAY_MS);
    // Don't let the escalation timer keep the process alive on its own.
    sigkillTimer.unref?.();
    void (r.lifecycle ?? Promise.resolve()).finally(() =>
      clearTimeout(sigkillTimer),
    );

    return { id: r.id, command: r.command, alreadyExited: false };
  }

  drainNotifications(): string[] {
    const out = this.completedIds.slice();
    this.completedIds.length = 0;
    return out;
  }

  /** True when commands have finished but their completion is not yet drained. */
  hasPending(): boolean {
    return this.completedIds.length > 0;
  }

  /**
   * Consume the output produced since the last `read` for this command. The
   * buffer is a fixed-size ring, so if output scrolled past the cap between
   * reads the dropped byte count is reported rather than silently lost. Works
   * for running and finished commands alike. Throws on an unknown id.
   */
  read(id: string): ReadResult {
    const r = this.records.get(id);
    if (!r) {
      throw new LongRunningCommandError(`no background command with id ${id}`);
    }
    const buf = r.buf;
    // The live buffer holds produced-bytes [truncated, produced); anything
    // before `truncated` has already scrolled out.
    const produced = buf.truncated + buf.bytes;
    const droppedBytes = Math.max(0, buf.truncated - r.readCursor);
    const liveStart = Math.max(r.readCursor, buf.truncated);
    const sliceStart = liveStart - buf.truncated;
    const output = Buffer.concat(buf.chunks)
      .subarray(sliceStart)
      .toString("utf8");
    r.readCursor = produced;
    return {
      id: r.id,
      command: r.command,
      status: r.status,
      output,
      droppedBytes,
    };
  }

  /**
   * Build the completion payload for the notifier: the output not yet consumed
   * by `read` (so already-streamed content is not re-pushed), prefixed with a
   * dropped-bytes notice and suffixed with the exit/termination marker. Returns
   * undefined for an unknown id. Advances the read cursor like `read`.
   */
  takeCompletion(
    id: string,
  ): { id: string; command: string; status: CommandStatus; body: string } | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    const { output, droppedBytes } = this.read(id);
    let body = output;
    if (droppedBytes > 0) {
      body = `[dropped ${droppedBytes} earlier bytes]\n${body}`;
    }
    if (r.reason) {
      body = body ? `${body}\n[${r.reason}]` : `[${r.reason}]`;
    }
    if (!body) body = "[no new output]";
    return { id: r.id, command: r.command, status: r.status, body };
  }

  get(id: string): CommandRecord | undefined {
    const r = this.records.get(id);
    return r ? publicView(r) : undefined;
  }

  list(): CommandRecord[] {
    return Array.from(this.records.values(), publicView);
  }

  async disposeAll(): Promise<void> {
    const running = Array.from(this.records.values()).filter(
      (r) => r.status === "running" && r.child,
    );
    if (running.length === 0) return;

    for (const r of running) {
      try {
        r.child?.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }

    const sigkillTimer = setTimeout(() => {
      for (const r of running) {
        try {
          r.child?.kill("SIGKILL");
        } catch {
          // best-effort
        }
      }
    }, DISPOSE_SIGKILL_DELAY_MS);

    await Promise.allSettled(running.map((r) => r.lifecycle ?? Promise.resolve()));
    clearTimeout(sigkillTimer);
  }
}
