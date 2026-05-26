import { randomBytes } from "node:crypto";
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
): { status: CommandStatus; result: string } {
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
  return { status: "error", result };
}

export class LongRunningCommandManager {
  private readonly records = new Map<string, InternalRecord>();
  private readonly completedIds: string[] = [];
  private readonly bufferBytes: number;
  private readonly maxConcurrent: number;

  constructor(opts: ManagerOptions = {}) {
    this.bufferBytes = opts.bufferBytes ?? DEFAULT_BUFFER_BYTES;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  start(input: StartInput): { id: string } {
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
      const { status, result } = finalize(buf, null, null, msg);
      const record: InternalRecord = {
        id,
        pid: -1,
        command: input.command,
        status,
        result,
        buf,
      };
      this.records.set(id, record);
      this.completedIds.push(id);
      return { id };
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
    };
    this.records.set(id, record);

    record.lifecycle = child.then(
      (res) => {
        const signal = (res.signal ?? null) as NodeJS.Signals | null;
        const exitCode = res.exitCode ?? null;
        const { status, result } = finalize(buf, signal, exitCode, undefined);
        record.status = status;
        record.result = result;
        record.child = undefined;
        this.completedIds.push(id);
      },
      (err: ExecaError) => {
        const signal = (err.signal ?? null) as NodeJS.Signals | null;
        const exitCode = err.exitCode ?? null;
        const msg = err.shortMessage ?? err.message ?? String(err);
        const { status, result } = finalize(buf, signal, exitCode, msg);
        record.status = status;
        record.result = result;
        record.child = undefined;
        this.completedIds.push(id);
      },
    );

    return { id };
  }

  drainNotifications(): string[] {
    const out = this.completedIds.slice();
    this.completedIds.length = 0;
    return out;
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
