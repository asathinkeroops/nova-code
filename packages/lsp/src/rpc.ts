import type { Readable, Writable } from "node:stream";

/**
 * JSON-RPC 2.0 over the LSP base protocol: each message is a UTF-8 JSON body
 * prefixed with `Content-Length: N\r\n\r\n`. This class owns the framing,
 * request/response correlation by integer id, and per-request timeouts. It is
 * transport-agnostic — wire it to a child process's stdin/stdout.
 */

export type JsonValue = unknown;

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type NotificationHandler = (method: string, params: unknown) => void;
/**
 * Handler for server→client requests. Return the `result` to send back, or a
 * rejected promise to send an error. The connection auto-replies for any
 * method without a handler with a null result so the server never blocks.
 */
export type RequestHandler = (method: string, params: unknown) => Promise<JsonValue> | JsonValue;

export interface RpcOptions {
  requestTimeoutMs?: number;
  onNotification?: NotificationHandler;
  onRequest?: RequestHandler;
  /** Called when the underlying stream errors or closes unexpectedly. */
  onClose?: (err?: Error) => void;
}

const HEADER_TERMINATOR = "\r\n\r\n";

export class RpcConnection {
  private readonly stdin: Writable;
  private readonly requestTimeoutMs: number;
  private readonly onNotification: NotificationHandler | undefined;
  private readonly onRequest: RequestHandler | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private closeError: Error | undefined;

  constructor(stdin: Writable, stdout: Readable, opts: RpcOptions = {}) {
    this.stdin = stdin;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.onNotification = opts.onNotification;
    this.onRequest = opts.onRequest;

    stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    const fail = (err?: Error) => {
      this.handleClose(err);
      opts.onClose?.(err);
    };
    stdout.on("close", () => fail());
    stdout.on("error", (err: Error) => fail(err));
  }

  /** Send a request and resolve with its `result` (or reject on error/timeout). */
  request(method: string, params?: unknown): Promise<JsonValue> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("lsp connection closed"));
    }
    const id = this.nextId++;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`lsp request "${method}" timed out after ${this.requestTimeoutMs}ms`));
            }, this.requestTimeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Reject all pending requests and stop accepting new ones. */
  dispose(err?: Error): void {
    this.handleClose(err ?? new Error("lsp connection disposed"));
  }

  private handleClose(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    const reason = err ?? new Error("lsp connection closed");
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  private send(msg: RpcMessage): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}${HEADER_TERMINATOR}`, "ascii");
    this.stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Drain as many complete frames as the buffer holds.
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unrecoverable framing error; drop the bad header and resync.
        this.buffer = this.buffer.subarray(headerEnd + HEADER_TERMINATOR.length);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + HEADER_TERMINATOR.length;
      if (this.buffer.length < bodyStart + length) return; // wait for more bytes
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(body);
    }
  }

  private dispatch(body: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(body) as RpcMessage;
    } catch {
      return; // ignore malformed payloads
    }

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`lsp error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Server→client request (has both id and method).
    if (msg.id !== undefined && msg.method) {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }

    // Notification (method, no id).
    if (msg.method) {
      this.onNotification?.(msg.method, msg.params);
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      const result = this.onRequest ? await this.onRequest(method, params) : null;
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
