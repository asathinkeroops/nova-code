import { HookRegistry } from "@nova/core";
import { describe, expect, it } from "vitest";
import type { CliContext } from "./context.js";
import { emitInit, registerHeadlessStream } from "./headless-events.js";

/** Build a CliContext stub exposing just what the event stream reads. */
function fakeCtx(registry: HookRegistry): CliContext {
  return {
    agent: { on: registry.on.bind(registry) },
    session: { id: "sess-1" },
    settings: { model: "deepseek-chat" },
    workspace: "/work",
  } as unknown as CliContext;
}

/** Collect emitted chunks and parse them back into one object per line. */
function collector(): { write: (chunk: string) => void; events: () => unknown[] } {
  let buf = "";
  return {
    write: (chunk) => void (buf += chunk),
    events: () =>
      buf
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l)),
  };
}

describe("headless event stream", () => {
  it("emits an init line describing the run", () => {
    const out = collector();
    emitInit(out.write, fakeCtx(new HookRegistry()), "acceptEdits");
    expect(out.events()).toEqual([
      {
        type: "system",
        subtype: "init",
        sessionId: "sess-1",
        model: "deepseek-chat",
        cwd: "/work",
        permissionMode: "acceptEdits",
      },
    ]);
  });

  it("streams one event per assistant content block, in order", async () => {
    const registry = new HookRegistry();
    const out = collector();
    registerHeadlessStream(fakeCtx(registry), out.write);

    await registry.runAdvisory("post_assistant", {
      stopReason: "tool_use",
      content: [
        { type: "thinking", thinking: "let me think", signature: "sig" },
        { type: "text", text: "reading the file" },
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
      ],
    });

    expect(out.events()).toEqual([
      { type: "thinking", text: "let me think" },
      { type: "text", text: "reading the file" },
      { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
    ]);
  });

  it("emits tool results with the tool name and error flag", async () => {
    const registry = new HookRegistry();
    const out = collector();
    registerHeadlessStream(fakeCtx(registry), out.write);

    await registry.runBlocking("post_tool_use", {
      use: { type: "tool_use", id: "t1", name: "bash", input: {} },
      result: { type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true },
    });

    expect(out.events()).toEqual([
      { type: "tool_result", toolUseId: "t1", name: "bash", isError: true, content: "boom" },
    ]);
  });

  it("flattens array tool-result content and marks images", async () => {
    const registry = new HookRegistry();
    const out = collector();
    registerHeadlessStream(fakeCtx(registry), out.write);

    await registry.runBlocking("post_tool_use", {
      use: { type: "tool_use", id: "t2", name: "read", input: {} },
      result: {
        type: "tool_result",
        tool_use_id: "t2",
        content: [
          { type: "text", text: "line1" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
        ],
      },
    });

    const events = out.events() as Array<{ content: string; isError: boolean }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe("line1[image]");
    expect(events[0]?.isError).toBe(false);
  });

  it("reports permission outcomes, with reason only when denied", async () => {
    const registry = new HookRegistry();
    const out = collector();
    registerHeadlessStream(fakeCtx(registry), out.write);

    await registry.runAdvisory("post_permission", {
      tool: "write",
      toolUseId: "t1",
      granted: false,
      reason: "denied at prompt",
    });
    await registry.runAdvisory("post_permission", {
      tool: "read",
      toolUseId: "t2",
      granted: true,
    });

    expect(out.events()).toEqual([
      { type: "permission", tool: "write", toolUseId: "t1", granted: false, reason: "denied at prompt" },
      { type: "permission", tool: "read", toolUseId: "t2", granted: true },
    ]);
  });
});
