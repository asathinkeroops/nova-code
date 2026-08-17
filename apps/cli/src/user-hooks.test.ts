import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolResultBlock, ToolUseBlock } from "@nova/core";
import type { Settings } from "@nova/base";
import {
  UserHooks,
  parseHookOutput,
  resultText,
  selectHooks,
  toolFields,
  type HookRunner,
  type HookRunResult,
  type UserHooksDeps,
} from "./user-hooks.js";

const CWD = "/work";
const SESSION = { id: "sess-1", transcriptPath: "/work/.nova/sessions/sess-1/transcript.jsonl" };

function hooksConfig(partial: Partial<Settings["hooks"]> = {}): Settings["hooks"] {
  return {
    enabled: true,
    PreToolUse: [],
    PostToolUse: [],
    UserPromptSubmit: [],
    Stop: [],
    SessionStart: [],
    SessionEnd: [],
    PreCompact: [],
    PostCompact: [],
    ...partial,
  };
}

function use(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id: "u1", name, input };
}

function result(content: string, isError = false): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: "u1",
    content,
    ...(isError ? { is_error: true } : {}),
  };
}

type Handler = (payload: unknown) => unknown;

interface Call {
  command: string;
  input: string;
}

interface Harness {
  fire(point: string, payload: unknown): Promise<unknown>;
  has(point: string): boolean;
  calls: Call[];
  /** The parsed stdin payload of the most recent hook command. */
  payload(index?: number): Record<string, unknown>;
  hooks: UserHooks;
}

function setup(
  config: Settings["hooks"],
  results: Record<string, HookRunResult> = {},
  extra: Partial<UserHooksDeps> = {},
): Harness {
  const handlers = new Map<string, Handler[]>();
  const calls: Call[] = [];
  const run: HookRunner = async (command, { input }) => {
    calls.push({ command, input });
    return results[command] ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  const on = ((point: string, fn: Handler) => {
    const arr = handlers.get(point) ?? [];
    arr.push(fn);
    handlers.set(point, arr);
    return () => {};
  }) as unknown as Parameters<UserHooks["register"]>[0];

  const hooks = new UserHooks({
    config,
    cwd: CWD,
    getSignal: () => undefined,
    getSession: () => SESSION,
    run,
    ...extra,
  });
  hooks.register(on);

  return {
    calls,
    hooks,
    has: (point) => (handlers.get(point)?.length ?? 0) > 0,
    payload: (index = 0) => JSON.parse(calls[index]?.input ?? "{}") as Record<string, unknown>,
    async fire(point, payload) {
      for (const fn of handlers.get(point) ?? []) {
        const out = await fn(payload);
        if (out !== undefined) return out;
      }
      return undefined;
    },
  };
}

describe("selectHooks", () => {
  it("keeps hooks with no matcher and matcher hits, drops misses", () => {
    const hooks = [
      { command: "all", timeout_ms: 1000 },
      { matcher: "write|edit", command: "writes", timeout_ms: 1000 },
      { matcher: "bash", command: "bashonly", timeout_ms: 1000 },
    ];
    expect(selectHooks(hooks, "write").map((h) => h.command)).toEqual(["all", "writes"]);
    expect(selectHooks(hooks, "bash").map((h) => h.command)).toEqual(["all", "bashonly"]);
  });

  it("matches lifecycle subjects (source/trigger), not just tool names", () => {
    const hooks = [{ matcher: "auto", command: "x", timeout_ms: 1000 }];
    expect(selectHooks(hooks, "auto")).toHaveLength(1);
    expect(selectHooks(hooks, "manual")).toHaveLength(0);
  });

  it("treats an un-compilable matcher as a non-match instead of throwing", () => {
    const hooks = [{ matcher: "(", command: "bad", timeout_ms: 1000 }];
    expect(selectHooks(hooks, "write")).toEqual([]);
  });
});

describe("toolFields", () => {
  it("resolves file_paths for write/edit only", () => {
    expect(toolFields(CWD, use("write", { path: "src/a.ts" })).file_paths).toEqual([
      resolve(CWD, "src/a.ts"),
    ]);
    expect(toolFields(CWD, use("bash", { command: "ls" })).file_paths).toBeUndefined();
  });

  it("includes tool name, raw input, and result fields when given a result", () => {
    const fields = toolFields(CWD, use("edit", { path: "a" }), result("done", true));
    expect(fields.tool_name).toBe("edit");
    expect(fields.tool_input).toEqual({ path: "a" });
    expect(fields.tool_response).toBe("done");
    expect(fields.is_error).toBe(true);
  });
});

describe("parseHookOutput", () => {
  it("returns null for plain text and non-object JSON", () => {
    expect(parseHookOutput("formatted a.ts")).toBeNull();
    expect(parseHookOutput("")).toBeNull();
    expect(parseHookOutput("123")).toBeNull();
    expect(parseHookOutput('"hi"')).toBeNull();
    expect(parseHookOutput("[1,2]")).toBeNull();
    expect(parseHookOutput("{not json")).toBeNull();
  });

  it("returns null for an object with no recognized control fields", () => {
    expect(parseHookOutput('{"foo": 1}')).toBeNull();
  });

  it("flattens decision/reason and hookSpecificOutput fields", () => {
    expect(
      parseHookOutput(
        JSON.stringify({
          decision: "block",
          reason: "nope",
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: "dangerous",
            additionalContext: "ctx",
          },
        }),
      ),
    ).toEqual({
      decision: "block",
      reason: "nope",
      permissionDecision: "deny",
      permissionDecisionReason: "dangerous",
      additionalContext: "ctx",
    });
  });

  it("ignores invalid enum values", () => {
    expect(parseHookOutput('{"decision": "maybe"}')).toBeNull();
    expect(parseHookOutput('{"hookSpecificOutput": {"permissionDecision": "nope"}}')).toBeNull();
  });
});

describe("resultText", () => {
  it("flattens array content to a string", () => {
    expect(
      resultText({
        type: "tool_result",
        tool_use_id: "u1",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
  });
});

describe("UserHooks.evaluatePreToolUse", () => {
  it("returns none when disabled (and runs no command)", async () => {
    const h = setup(
      hooksConfig({ enabled: false, PreToolUse: [{ command: "x", timeout_ms: 1 }] }),
      { x: { exitCode: 2, stdout: "", stderr: "" } },
    );
    expect(await h.hooks.evaluatePreToolUse("bash", { command: "ls" })).toEqual({
      decision: "none",
    });
    expect(h.calls).toHaveLength(0);
  });

  it("feeds the event payload as JSON on stdin with the common fields", async () => {
    const h = setup(hooksConfig({ PreToolUse: [{ command: "guard", timeout_ms: 1000 }] }));
    await h.hooks.evaluatePreToolUse("bash", { command: "ls" });
    expect(h.payload()).toEqual({
      hook_event_name: "PreToolUse",
      session_id: SESSION.id,
      transcript_path: SESSION.transcriptPath,
      cwd: CWD,
      tool_name: "bash",
      tool_input: { command: "ls" },
    });
  });

  it("denies on non-zero exit with stderr as reason", async () => {
    const h = setup(
      hooksConfig({ PreToolUse: [{ matcher: "bash", command: "guard", timeout_ms: 1000 }] }),
      { guard: { exitCode: 2, stdout: "", stderr: "nope" } },
    );
    expect(await h.hooks.evaluatePreToolUse("bash", { command: "rm" })).toEqual({
      decision: "deny",
      reason: "nope",
    });
  });

  it("denies via JSON permissionDecision even on zero exit", async () => {
    const h = setup(hooksConfig({ PreToolUse: [{ command: "guard", timeout_ms: 1000 }] }), {
      guard: {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "danger" },
        }),
        stderr: "",
      },
    });
    expect(await h.hooks.evaluatePreToolUse("bash", { command: "rm" })).toEqual({
      decision: "deny",
      reason: "danger",
    });
  });

  it("allows (bypass) via JSON permissionDecision, overriding a non-zero exit", async () => {
    const h = setup(hooksConfig({ PreToolUse: [{ command: "guard", timeout_ms: 1000 }] }), {
      guard: {
        exitCode: 1,
        stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
        stderr: "",
      },
    });
    expect(await h.hooks.evaluatePreToolUse("bash", { command: "ls" })).toEqual({
      decision: "allow",
    });
  });

  it("asks via JSON permissionDecision, carrying the reason", async () => {
    const h = setup(hooksConfig({ PreToolUse: [{ command: "guard", timeout_ms: 1000 }] }), {
      guard: {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "confirm" },
        }),
        stderr: "",
      },
    });
    expect(await h.hooks.evaluatePreToolUse("bash", { command: "rm" })).toEqual({
      decision: "ask",
      reason: "confirm",
    });
  });

  it("returns none on zero exit (defer to the gate) and skips non-matching tools", async () => {
    const h = setup(
      hooksConfig({ PreToolUse: [{ matcher: "bash", command: "guard", timeout_ms: 1000 }] }),
      { guard: { exitCode: 0, stdout: "", stderr: "" } },
    );
    expect(await h.hooks.evaluatePreToolUse("write", { path: "a" })).toEqual({ decision: "none" });
    expect(h.calls).toHaveLength(0); // matcher excluded the write tool
    expect(await h.hooks.evaluatePreToolUse("bash", { command: "ls" })).toEqual({
      decision: "none",
    });
    expect(h.calls).toHaveLength(1);
  });

  it("deny short-circuits; otherwise ask outranks allow across multiple hooks", async () => {
    const h = setup(
      hooksConfig({
        PreToolUse: [
          {
            command: "a",
            timeout_ms: 1000,
          },
          { command: "b", timeout_ms: 1000 },
        ],
      }),
      {
        a: {
          exitCode: 0,
          stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
          stderr: "",
        },
        b: {
          exitCode: 0,
          stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } }),
          stderr: "",
        },
      },
    );
    expect(await h.hooks.evaluatePreToolUse("bash", { command: "x" })).toEqual({ decision: "ask" });
    expect(h.calls).toHaveLength(2);
  });
});

describe("UserHooks.register", () => {
  it("PostToolUse appends stdout to the tool result and includes tool_response on stdin", async () => {
    const h = setup(
      hooksConfig({ PostToolUse: [{ matcher: "write|edit", command: "fmt", timeout_ms: 1000 }] }),
      { fmt: { exitCode: 0, stdout: "formatted a.ts", stderr: "" } },
    );
    const decision = (await h.fire("post_tool_use", {
      use: use("write", { path: "a.ts" }),
      result: result("wrote 10 bytes"),
    })) as { result: ToolResultBlock };
    expect(decision.result.content).toBe("wrote 10 bytes\n\n[PostToolUse hook]\nformatted a.ts");
    expect(decision.result.is_error).toBe(false);
    expect(h.payload()).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_name: "write",
      tool_response: "wrote 10 bytes",
      is_error: false,
    });
  });

  it("PostToolUse uses JSON additionalContext instead of raw stdout, and decision:block flags error", async () => {
    const h = setup(hooksConfig({ PostToolUse: [{ command: "check", timeout_ms: 1000 }] }), {
      check: {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: "block",
          reason: "schema drift",
          hookSpecificOutput: { additionalContext: "regenerated types" },
        }),
        stderr: "",
      },
    });
    const decision = (await h.fire("post_tool_use", {
      use: use("write", { path: "a.ts" }),
      result: result("ok"),
    })) as { result: ToolResultBlock };
    expect(decision.result.is_error).toBe(true);
    expect(decision.result.content).toBe(
      "ok\n\n[PostToolUse hook]\nregenerated types\nschema drift",
    );
  });

  it("PostToolUse marks the result as error on non-zero exit", async () => {
    const h = setup(hooksConfig({ PostToolUse: [{ command: "lint", timeout_ms: 1000 }] }), {
      lint: { exitCode: 1, stdout: "", stderr: "2 problems" },
    });
    const decision = (await h.fire("post_tool_use", {
      use: use("write", { path: "a.ts" }),
      result: result("ok"),
    })) as { result: ToolResultBlock };
    expect(decision.result.is_error).toBe(true);
    expect(decision.result.content).toContain("PostToolUse hook failed (exit 1): 2 problems");
  });

  it("PostToolUse is a no-op (undefined) when nothing matches or changes", async () => {
    const h = setup(
      hooksConfig({ PostToolUse: [{ matcher: "bash", command: "x", timeout_ms: 1000 }] }),
      { x: { exitCode: 0, stdout: "", stderr: "" } },
    );
    expect(
      await h.fire("post_tool_use", { use: use("write", { path: "a" }), result: result("ok") }),
    ).toBeUndefined();
  });

  it("UserPromptSubmit appends stdout to the input and sends `prompt` on stdin", async () => {
    const h = setup(hooksConfig({ UserPromptSubmit: [{ command: "ctx", timeout_ms: 1000 }] }), {
      ctx: { exitCode: 0, stdout: "branch: main", stderr: "" },
    });
    const decision = await h.fire("pre_user_prompt", { input: "fix the bug" });
    expect(decision).toEqual({ input: "fix the bug\n\nbranch: main" });
    expect(h.payload()).toMatchObject({ hook_event_name: "UserPromptSubmit", prompt: "fix the bug" });
  });

  it("UserPromptSubmit appends JSON additionalContext", async () => {
    const h = setup(hooksConfig({ UserPromptSubmit: [{ command: "ctx", timeout_ms: 1000 }] }), {
      ctx: {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "on branch main" } }),
        stderr: "",
      },
    });
    expect(await h.fire("pre_user_prompt", { input: "go" })).toEqual({
      input: "go\n\non branch main",
    });
  });

  it("UserPromptSubmit aborts via JSON decision:block even on zero exit", async () => {
    const h = setup(hooksConfig({ UserPromptSubmit: [{ command: "deny", timeout_ms: 1000 }] }), {
      deny: {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: "frozen" }),
        stderr: "",
      },
    });
    expect(await h.fire("pre_user_prompt", { input: "x" })).toEqual({
      abort: true,
      reason: "frozen",
    });
  });

  it("UserPromptSubmit aborts the turn on non-zero exit", async () => {
    const h = setup(hooksConfig({ UserPromptSubmit: [{ command: "deny", timeout_ms: 1000 }] }), {
      deny: { exitCode: 1, stdout: "", stderr: "blocked" },
    });
    expect(await h.fire("pre_user_prompt", { input: "x" })).toEqual({
      abort: true,
      reason: "blocked",
    });
  });

  it("does NOT register Stop on post_turn (it is REPL-driven via runStop)", () => {
    const h = setup(hooksConfig({ Stop: [{ command: "notify", timeout_ms: 1000 }] }));
    expect(h.has("post_turn")).toBe(false);
  });

  it("applies wrapCommand before running", async () => {
    const h = setup(
      hooksConfig({ PreToolUse: [{ command: "guard", timeout_ms: 1000 }] }),
      { "sandbox(guard)": { exitCode: 0, stdout: "", stderr: "" } },
      { wrapCommand: (cmd) => Promise.resolve(`sandbox(${cmd})`) },
    );
    await h.hooks.evaluatePreToolUse("bash", { command: "ls" });
    expect(h.calls[0]?.command).toBe("sandbox(guard)");
  });
});

describe("UserHooks.fire (lifecycle)", () => {
  it("runs matching lifecycle hooks with the given subject and fields", async () => {
    const h = setup(
      hooksConfig({
        SessionStart: [{ matcher: "startup|resume", command: "load", timeout_ms: 1000 }],
      }),
    );
    await h.hooks.fire("SessionStart", { subject: "startup", fields: { source: "startup" } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.command).toBe("load");
    expect(h.payload()).toMatchObject({ hook_event_name: "SessionStart", source: "startup" });
  });

  it("skips lifecycle hooks whose matcher excludes the subject", async () => {
    const h = setup(
      hooksConfig({ PreCompact: [{ matcher: "manual", command: "x", timeout_ms: 1000 }] }),
    );
    await h.hooks.fire("PreCompact", { subject: "auto" });
    expect(h.calls).toHaveLength(0);
  });

  it("reports a non-zero lifecycle exit without throwing", async () => {
    const reported: string[] = [];
    const h = setup(
      hooksConfig({ PostCompact: [{ command: "notify", timeout_ms: 1000 }] }),
      { notify: { exitCode: 4, stdout: "", stderr: "boom" } },
      { onError: (m) => reported.push(m) },
    );
    await h.hooks.fire("PostCompact", { subject: "auto" });
    expect(reported[0]).toContain("PostCompact hook exited 4: boom");
  });

  it("does nothing when hooks are disabled", async () => {
    const h = setup(
      hooksConfig({ enabled: false, SessionEnd: [{ command: "bye", timeout_ms: 1000 }] }),
    );
    await h.hooks.fire("SessionEnd", { subject: "exit" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("UserHooks.firePreCompact (blocking)", () => {
  it("exit 2 blocks compaction with stderr as the reason", async () => {
    const h = setup(hooksConfig({ PreCompact: [{ command: "veto", timeout_ms: 1000 }] }), {
      veto: { exitCode: 2, stdout: "", stderr: "keep history" },
    });
    expect(await h.hooks.firePreCompact({ subject: "auto", fields: { trigger: "auto" } })).toEqual({
      blocked: true,
      reason: "keep history",
    });
    expect(h.payload()).toMatchObject({ hook_event_name: "PreCompact", trigger: "auto" });
  });

  it("blocks via JSON decision:block even on zero exit", async () => {
    const h = setup(hooksConfig({ PreCompact: [{ command: "veto", timeout_ms: 1000 }] }), {
      veto: {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: "not now" }),
        stderr: "",
      },
    });
    expect(await h.hooks.firePreCompact({ subject: "auto" })).toEqual({
      blocked: true,
      reason: "not now",
    });
  });

  it("exit 0 does not block", async () => {
    const h = setup(hooksConfig({ PreCompact: [{ command: "ok", timeout_ms: 1000 }] }), {
      ok: { exitCode: 0, stdout: "", stderr: "" },
    });
    expect(await h.hooks.firePreCompact({ subject: "manual" })).toEqual({ blocked: false });
  });

  it("a non-2 non-zero exit is a non-blocking error (reported, not blocked)", async () => {
    const reported: string[] = [];
    const h = setup(
      hooksConfig({ PreCompact: [{ command: "warn", timeout_ms: 1000 }] }),
      { warn: { exitCode: 1, stdout: "", stderr: "oops" } },
      { onError: (m) => reported.push(m) },
    );
    expect(await h.hooks.firePreCompact({ subject: "auto" })).toEqual({ blocked: false });
    expect(reported[0]).toContain("PreCompact hook exited 1: oops");
  });
});

describe("UserHooks.runStop (force-continue)", () => {
  it("exit 2 forces continue with stderr as guidance", async () => {
    const h = setup(hooksConfig({ Stop: [{ command: "again", timeout_ms: 1000 }] }), {
      again: { exitCode: 2, stdout: "", stderr: "tests still failing" },
    });
    expect(await h.hooks.runStop({ stop_continuation: 0 })).toEqual({
      continue: true,
      reason: "tests still failing",
    });
  });

  it("forces continue via JSON decision:block even on zero exit", async () => {
    const h = setup(hooksConfig({ Stop: [{ command: "again", timeout_ms: 1000 }] }), {
      again: {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: "keep going" }),
        stderr: "",
      },
    });
    expect(await h.hooks.runStop({ stop_continuation: 0 })).toEqual({
      continue: true,
      reason: "keep going",
    });
  });

  it("exit 0 ends the turn (no continue)", async () => {
    const h = setup(hooksConfig({ Stop: [{ command: "ok", timeout_ms: 1000 }] }), {
      ok: { exitCode: 0, stdout: "", stderr: "" },
    });
    expect(await h.hooks.runStop({})).toEqual({ continue: false });
  });

  it("forwards stop_continuation on stdin", async () => {
    const h = setup(hooksConfig({ Stop: [{ command: "again", timeout_ms: 1000 }] }), {
      again: { exitCode: 2, stdout: "", stderr: "go" },
    });
    await h.hooks.runStop({ stop_continuation: 3 });
    expect(h.payload()).toMatchObject({ hook_event_name: "Stop", stop_continuation: 3 });
  });

  it("returns no continue when disabled", async () => {
    const h = setup(
      hooksConfig({ enabled: false, Stop: [{ command: "again", timeout_ms: 1000 }] }),
      {
        again: { exitCode: 2, stdout: "", stderr: "go" },
      },
    );
    expect(await h.hooks.runStop({})).toEqual({ continue: false });
  });
});
