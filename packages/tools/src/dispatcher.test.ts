import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolHandler, ToolUseBlock } from "@nova/core";
import { createDispatcher } from "./dispatcher.js";
import { ToolRegistry } from "./registry.js";

function makeHandler(run = vi.fn(async () => ({ output: "ok" }))): ToolHandler {
  return {
    definition: {
      name: "echo",
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
    },
    run,
  };
}

function uses(name: string, input: unknown): ToolUseBlock {
  return { type: "tool_use", id: "u_1", name, input: input as Record<string, unknown> };
}

describe("dispatcher", () => {
  it("returns is_error when the tool is unknown", async () => {
    const reg = new ToolRegistry();
    const dispatch = createDispatcher({ registry: reg });
    const r = await dispatch(uses("nope", {}), { cwd: "/tmp" });
    expect(r.is_error).toBe(true);
    expect(typeof r.content).toBe("string");
  });

  it("returns is_error when input schema fails", async () => {
    const reg = new ToolRegistry().register(makeHandler());
    const dispatch = createDispatcher({ registry: reg });
    const r = await dispatch(uses("echo", { msg: 42 }), { cwd: "/tmp" });
    expect(r.is_error).toBe(true);
  });

  it("runs the tool and returns its output", async () => {
    const run = vi.fn(async () => ({ output: "hello world" }));
    const reg = new ToolRegistry().register(makeHandler(run));
    const dispatch = createDispatcher({ registry: reg });
    const r = await dispatch(uses("echo", { msg: "hi" }), { cwd: "/tmp" });
    expect(r.is_error).toBeUndefined();
    expect(r.content).toBe("hello world");
    expect(run).toHaveBeenCalledOnce();
  });

  it("catches exceptions thrown by the handler", async () => {
    const throwing = vi.fn(async (): Promise<{ output: string }> => {
      throw new Error("kaboom");
    });
    const reg = new ToolRegistry().register(makeHandler(throwing));
    const dispatch = createDispatcher({ registry: reg });
    const r = await dispatch(uses("echo", { msg: "hi" }), { cwd: "/tmp" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toContain("kaboom");
  });
});
