import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { RpcConnection } from "./rpc.js";

/** Encode a JSON-RPC message in the LSP base-protocol frame. */
function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Read one framed message off a stream and return its parsed body. */
function readFrame(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString())?.[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) return;
      stream.off("data", onData);
      resolve(JSON.parse(buf.subarray(start, start + len).toString("utf8")));
    };
    stream.on("data", onData);
  });
}

describe("RpcConnection", () => {
  it("correlates a request with its response", async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const conn = new RpcConnection(toServer, toClient);

    const pending = conn.request("textDocument/hover", { x: 1 });
    const req = await readFrame(toServer);
    expect(req).toMatchObject({ method: "textDocument/hover", params: { x: 1 }, id: 1 });

    toClient.write(frame({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("rejects on an error response", async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const conn = new RpcConnection(toServer, toClient);
    const pending = conn.request("foo");
    const req = await readFrame(toServer);
    toClient.write(frame({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: "boom" } }));
    await expect(pending).rejects.toThrow(/boom/);
  });

  it("reassembles a frame split across chunks", async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const received: Array<[string, unknown]> = [];
    new RpcConnection(toServer, toClient, {
      onNotification: (m, p) => received.push([m, p]),
    });
    const full = frame({ jsonrpc: "2.0", method: "ping", params: { n: 7 } });
    toClient.write(full.subarray(0, 10));
    toClient.write(full.subarray(10));
    await new Promise((r) => setImmediate(r));
    expect(received).toEqual([["ping", { n: 7 }]]);
  });

  it("auto-replies to server→client requests via the handler", async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    new RpcConnection(toServer, toClient, {
      onRequest: (method) => (method === "workspace/configuration" ? [{}] : null),
    });
    toClient.write(frame({ jsonrpc: "2.0", id: 99, method: "workspace/configuration", params: {} }));
    const reply = await readFrame(toServer);
    expect(reply).toMatchObject({ id: 99, result: [{}] });
  });

  it("rejects pending requests when the connection closes", async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const conn = new RpcConnection(toServer, toClient);
    const pending = conn.request("foo");
    conn.dispose(new Error("gone"));
    await expect(pending).rejects.toThrow(/gone/);
  });
});
