import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, openSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { execa, type ExecaError, type ResultPromise } from "execa";
import { DETACHED_SPAWN, awaitBounded, terminateGroup } from "../process-group.js";

export type CommandStatus = "running" | "completed" | "error";

export interface CommandRecord {
  id: string;
  pid: number;
  command: string;
  status: CommandStatus;
  result?: string;
  /**
   * Absolute path of the log file this command's stdout+stderr is teed to, when
   * the manager was constructed with an `outputDir`. This is the model's read
   * path for a still-running command — it uses the ordinary `read`/`grep` tools
   * on it, so there is no dedicated background-output tool.
   */
  outputPath?: string;
}

export interface StartInput {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /**
   * Human-facing command recorded for display and completion notices. When the
   * caller wraps `command` for execution (e.g. a sandbox prefix), pass the
   * original here so records show what the user/model actually asked for rather
   * than the wrapper boilerplate. Defaults to `command`.
   */
  label?: string;
}

export interface ManagerOptions {
  bufferBytes?: number;
  maxConcurrent?: number;
  /**
   * Directory to tee each command's combined stdout+stderr into, one
   * `{id}.log` per command. Created lazily on first start. When omitted, output
   * is kept only in the in-memory ring buffer (tests, headless embedders) and
   * records carry no `outputPath`.
   *
   * The file is the *full* transcript — unlike the ring buffer it is never
   * truncated — which is what makes it a sound read target for the model after
   * a long-running command has overflowed `bufferBytes`.
   */
  outputDir?: string;
}

export interface KillResult {
  id: string;
  command: string;
  /** True when the command had already finished, so the kill was a no-op. */
  alreadyExited: boolean;
}

/**
 * What the completion notifier announces when a command finishes. It is
 * deliberately metadata-only: the output itself lives in `outputPath` and the
 * model reads it with the ordinary `read`/`grep` tools if it wants it.
 *
 * Inlining the output here as well would give the same bytes two delivery
 * channels — and two channels of one payload is exactly what needs (and would
 * inevitably drift out of) de-duplication. `inlineOutput` is therefore set ONLY
 * in the degraded no-`outputDir` configuration, where there is no file to point
 * at and it becomes the single channel rather than a second one.
 */
export interface CompletionNotice {
  id: string;
  command: string;
  status: CommandStatus;
  /** Where the full stdout+stderr log lives; absent only without an outputDir. */
  outputPath?: string;
  /** Exit/termination marker for a failed command (unbracketed). */
  reason?: string;
  /** Full output, present ONLY when there is no `outputPath` to point at. */
  inlineOutput?: string;
}

const DEFAULT_BUFFER_BYTES = 1_000_000;
const DEFAULT_MAX_CONCURRENT = 8;

export class BackgroundCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundCommandError";
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
  /** Exit/termination marker (unbracketed) for error completions, if any. */
  reason?: string;
  /** Open handle on `outputPath`, closed when the command finishes. */
  sink?: WriteStream;
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
  if (r.outputPath !== undefined) view.outputPath = r.outputPath;
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

export class BackgroundCommandManager extends EventEmitter {
  private readonly records = new Map<string, InternalRecord>();
  private readonly completedIds: string[] = [];
  private readonly bufferBytes: number;
  private readonly maxConcurrent: number;
  private readonly outputDir: string | undefined;
  /** Set once the outputDir has been mkdir'd, so we only pay for it on demand. */
  private outputDirReady = false;

  constructor(opts: ManagerOptions = {}) {
    super();
    this.bufferBytes = opts.bufferBytes ?? DEFAULT_BUFFER_BYTES;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.outputDir = opts.outputDir;
  }

  /**
   * Open the per-command log file. Best-effort: a failure here (unwritable dir,
   * full disk) must not stop the command from running, so it degrades to the
   * in-memory buffer alone and the record simply carries no `outputPath`.
   */
  private openSink(id: string): { path: string; stream: WriteStream } | undefined {
    if (this.outputDir === undefined) return undefined;
    try {
      if (!this.outputDirReady) {
        mkdirSync(this.outputDir, { recursive: true });
        this.outputDirReady = true;
      }
      const path = join(this.outputDir, `${id}.log`);
      // Open the fd synchronously and hand it to the stream: createWriteStream
      // alone opens lazily, so `start()` would return a path that does not exist
      // yet and an immediate `read` of it would fail with ENOENT.
      const fd = openSync(path, "a");
      const stream = createWriteStream(path, { fd });
      // A write error after open (disk full, dir removed mid-run) must not
      // surface as an unhandled 'error' event and take the process down.
      stream.on("error", () => {});
      return { path, stream };
    } catch {
      return undefined;
    }
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

  start(input: StartInput): { id: string; pid: number; outputPath?: string } {
    const running = Array.from(this.records.values()).filter((r) => r.status === "running");
    if (running.length >= this.maxConcurrent) {
      throw new BackgroundCommandError(
        `concurrent command limit reached (${this.maxConcurrent}); wait for some to finish`,
      );
    }

    let id = generateId();
    while (this.records.has(id)) id = generateId();

    // What gets recorded/shown — defaults to the executed command, but the
    // caller can supply the original when `command` is a wrapped form.
    const displayCommand = input.label ?? input.command;
    const env = input.env ? { ...process.env, ...input.env } : undefined;
    const buf: OutputBuffer = { chunks: [], bytes: 0, truncated: 0 };
    const sink = this.openSink(id);

    let child: ResultPromise;
    try {
      child = execa(input.command, {
        shell: "/bin/bash",
        cwd: input.cwd,
        ...(env ? { env } : {}),
        all: true,
        reject: false,
        buffer: false,
        // Own process group: `pnpm dev` and friends fork children that inherit
        // the output pipe, and signalling only the shell leaves them running —
        // the unclosed pipe then keeps this promise from ever settling, hanging
        // session teardown. See process-group.ts.
        ...DETACHED_SPAWN,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const { status, result, reason } = finalize(buf, null, null, msg);
      // The command never ran, but the log file was already created — write the
      // spawn failure into it so a `read` of outputPath explains the emptiness.
      sink?.stream.end(`[${reason ?? msg}]\n`);
      const record: InternalRecord = {
        id,
        pid: -1,
        command: displayCommand,
        status,
        result,
        buf,
        ...(reason !== undefined ? { reason } : {}),
        ...(sink ? { outputPath: sink.path } : {}),
      };
      this.records.set(id, record);
      this.markComplete(record);
      return { id, pid: record.pid, ...(sink ? { outputPath: sink.path } : {}) };
    }

    const cap = this.bufferBytes;
    // Two sinks per chunk: the capped ring buffer (incremental `read` + the
    // completion notice) and the uncapped log file (what the model `read`s).
    child.all?.on("data", (chunk: Buffer) => {
      appendChunk(buf, chunk, cap);
      sink?.stream.write(chunk);
    });

    const record: InternalRecord = {
      id,
      pid: child.pid ?? -1,
      command: displayCommand,
      status: "running",
      buf,
      child,
      ...(sink ? { outputPath: sink.path, sink: sink.stream } : {}),
    };
    this.records.set(id, record);

    /** Shared tail of both lifecycle branches: close the log, then announce. */
    const settle = (status: CommandStatus, result: string, reason: string | undefined): void => {
      record.status = status;
      record.result = result;
      if (reason !== undefined) record.reason = reason;
      record.child = undefined;
      // Flush the exit marker into the log too, so the file is self-describing:
      // a `read` after the fact shows how the command ended, not just its output.
      record.sink?.end(reason !== undefined ? `\n[${reason}]\n` : "");
      record.sink = undefined;
      this.markComplete(record);
    };

    record.lifecycle = child.then(
      (res) => {
        const signal = (res.signal ?? null) as NodeJS.Signals | null;
        const exitCode = res.exitCode ?? null;
        const { status, result, reason } = finalize(buf, signal, exitCode, undefined);
        settle(status, result, reason);
      },
      (err: ExecaError) => {
        const signal = (err.signal ?? null) as NodeJS.Signals | null;
        const exitCode = err.exitCode ?? null;
        const msg = err.shortMessage ?? err.message ?? String(err);
        const { status, result, reason } = finalize(buf, signal, exitCode, msg);
        settle(status, result, reason);
      },
    );

    return { id, pid: record.pid, ...(sink ? { outputPath: sink.path } : {}) };
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
      throw new BackgroundCommandError(`no background command with id ${id}`);
    }
    if (r.status !== "running" || !r.child) {
      return { id: r.id, command: r.command, alreadyExited: true };
    }

    const cancelEscalation = terminateGroup(r.child.pid);
    void (r.lifecycle ?? Promise.resolve()).finally(cancelEscalation);

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
   * Metadata the notifier announces when a command finishes: status, exit
   * reason, and where its log lives. Returns undefined for an unknown id.
   *
   * Deliberately does NOT carry the output. The log file is the single delivery
   * channel for it, and the model reads that file on its own schedule — pushing
   * the bytes here as well would re-deliver whatever it had already read, and
   * would dump up to `bufferBytes` into the append-only history in one lump.
   * The one exception is the no-`outputDir` configuration: with no file to point
   * at, `inlineOutput` carries the output because it is then the ONLY channel.
   */
  completionNotice(id: string): CompletionNotice | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    return {
      id: r.id,
      command: r.command,
      status: r.status,
      ...(r.outputPath !== undefined
        ? { outputPath: r.outputPath }
        : { inlineOutput: r.result ?? "" }),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    };
  }

  get(id: string): CommandRecord | undefined {
    const r = this.records.get(id);
    return r ? publicView(r) : undefined;
  }

  /**
   * Snapshot the retained output of a command, for the `/tasks` panel. This is
   * the ring buffer's only remaining consumer — the model reads the log file
   * instead — so the buffer exists purely to give the UI a bounded, in-memory
   * tail without re-reading (and unboundedly growing with) the file. Returns
   * the whole buffer, with a `[truncated …]` prefix if earlier output scrolled
   * out. Throws on an unknown id.
   */
  peek(id: string): { id: string; command: string; status: CommandStatus; output: string } {
    const r = this.records.get(id);
    if (!r) {
      throw new BackgroundCommandError(`no background command with id ${id}`);
    }
    return { id: r.id, command: r.command, status: r.status, output: renderOutput(r.buf) };
  }

  list(): CommandRecord[] {
    return Array.from(this.records.values(), publicView);
  }

  async disposeAll(): Promise<void> {
    const running = Array.from(this.records.values()).filter(
      (r) => r.status === "running" && r.child,
    );
    if (running.length === 0) return;

    const cancels = running.map((r) => terminateGroup(r.child?.pid));
    // Bounded, so a child that survives SIGKILL cannot wedge session exit.
    await awaitBounded(running.map((r) => r.lifecycle ?? Promise.resolve()));
    for (const cancel of cancels) cancel();
  }
}
