import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  InvariantsCheck,
  ToolExecutionResult,
  ToolHandler,
  ToolResultBlock,
  ToolUseBlock,
} from "@nova/core";
import { createDispatcher, formatValidationError } from "./dispatcher.js";
import { ToolRegistry } from "./registry.js";
import { PATH_ALIASES, withAliases } from "./schema.js";

function makeHandler(run: ToolHandler["run"] = vi.fn(async () => ({ output: "ok" }))): ToolHandler {
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

function resultOf(execution: ToolExecutionResult): ToolResultBlock {
  return "result" in execution ? execution.result : execution;
}

describe("dispatcher", () => {
  it("returns is_error when the tool is unknown", async () => {
    const reg = new ToolRegistry();
    const dispatch = createDispatcher({ registry: reg });
    const r = resultOf(await dispatch(uses("nope", {}), { cwd: "/tmp" }));
    expect(r.is_error).toBe(true);
    expect(typeof r.content).toBe("string");
  });

  it("returns is_error with a flattened, readable message when input schema fails", async () => {
    const reg = new ToolRegistry().register(makeHandler());
    const dispatch = createDispatcher({ registry: reg });
    const r = resultOf(await dispatch(uses("echo", { msg: 42 }), { cwd: "/tmp" }));
    expect(r.is_error).toBe(true);
    // No raw zod JSON dump leaks to the model.
    expect(String(r.content)).not.toContain('"code"');
    expect(String(r.content)).toContain("Invalid input for tool echo");
    expect(String(r.content)).toContain("msg:");
  });

  it("runs the tool and returns its output", async () => {
    const run = vi.fn(async () => ({ output: "hello world" }));
    const reg = new ToolRegistry().register(makeHandler(run));
    const dispatch = createDispatcher({ registry: reg });
    const r = resultOf(await dispatch(uses("echo", { msg: "hi" }), { cwd: "/tmp" }));
    expect(r.is_error).toBeUndefined();
    expect(r.content).toBe("hello world");
    expect(run).toHaveBeenCalledOnce();
  });

  it("returns rich output as provider-neutral follow-up user messages", async () => {
    const run = vi.fn(async () => ({
      output: "image metadata",
      followupMessages: [
        {
          role: "user" as const,
          content: [
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/png" as const,
                data: "AAA",
              },
            },
          ],
        },
      ],
    }));
    const dispatch = createDispatcher({
      registry: new ToolRegistry().register(makeHandler(run)),
    });

    const execution = await dispatch(uses("echo", { msg: "hi" }), { cwd: "/tmp" });

    expect("result" in execution).toBe(true);
    if (!("result" in execution)) return;
    expect(execution.result.content).toBe("image metadata");
    expect(execution.followupMessages?.[0]?.role).toBe("user");
    expect(execution.followupMessages?.[0]?.content[0]?.type).toBe("image");
  });

  it("flattens a missing required field into an actionable hint", () => {
    const schema = z.object({
      path: z.string().min(1),
      offset: z.number().int().min(0).optional(),
    });
    // Mirrors the real failure: model paginates with offset but drops `path`.
    const parsed = schema.safeParse({ offset: 115, limit: 10 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(formatValidationError(parsed.error)).toBe("path is required (expected string)");
  });

  it("formats non-missing issues as `<path>: <message>`", () => {
    const schema = z.object({ path: z.string().min(1) });
    const parsed = schema.safeParse({ path: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(formatValidationError(parsed.error)).toContain("path: ");
  });

  it("catches exceptions thrown by the handler", async () => {
    const throwing = vi.fn(async (): Promise<{ output: string }> => {
      throw new Error("kaboom");
    });
    const reg = new ToolRegistry().register(makeHandler(throwing));
    const dispatch = createDispatcher({ registry: reg });
    const r = resultOf(await dispatch(uses("echo", { msg: "hi" }), { cwd: "/tmp" }));
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toContain("kaboom");
  });

  // Regression: when a schema rewrites keys before validation (withAliases maps
  // a `filePath` alias onto `path`), the invariants gate — which reads
  // `input.path` straight off the tool_use — must see the *normalized* input.
  // If the dispatcher fed it the raw `use.input`, read-before-edit / mtime-drift
  // gating would be silently skipped for any aliased call, letting an edit
  // clobber a file it never read.
  it("feeds the alias-normalized input to the invariants gate and the handler", async () => {
    const seen: {
      key?: unknown;
      pre?: unknown;
      before?: unknown;
      post?: unknown;
      after?: unknown;
    } = {};
    const invariants: InvariantsCheck = {
      async preCheck(use) {
        seen.pre = use.input;
        return { ok: true };
      },
      async postCommit(use) {
        seen.post = use.input;
      },
    };
    const run = vi.fn(async () => ({ output: "ok" }));
    const handler: ToolHandler = {
      definition: {
        name: "read",
        description: "read",
        inputSchema: withAliases(z.object({ path: z.string().min(1) }), { path: PATH_ALIASES }),
      },
      executionKey(input) {
        seen.key = input;
        return undefined;
      },
      run,
    };
    const reg = new ToolRegistry().register(handler);
    const dispatch = createDispatcher({
      registry: reg,
      invariants,
      lifecycle: {
        async beforeRun(use) {
          seen.before = use.input;
        },
        async afterRun(use) {
          seen.after = use.input;
        },
      },
    });

    // Model names the path `filePath` — the exact live DeepSeek failure.
    const r = resultOf(await dispatch(uses("read", { filePath: "/abs/x.ts" }), { cwd: "/tmp" }));

    expect(r.is_error).toBeUndefined();
    // Every scheduling/lifecycle/invariant layer sees canonical `path`, never the alias.
    expect(seen.key).toEqual({ path: "/abs/x.ts" });
    expect(seen.pre).toEqual({ path: "/abs/x.ts" });
    expect(seen.before).toEqual({ path: "/abs/x.ts" });
    expect(seen.post).toEqual({ path: "/abs/x.ts" });
    expect(seen.after).toEqual({ path: "/abs/x.ts" });
    expect(run).toHaveBeenCalledWith(
      { path: "/abs/x.ts" },
      expect.objectContaining({ toolUseId: "u_1" }),
    );
  });
});
