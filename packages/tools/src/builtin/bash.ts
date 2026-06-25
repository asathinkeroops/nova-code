import { execa, type ExecaError } from "execa";
import { z } from "zod";
import type { ToolContext, ToolHandler, ToolRunResult } from "@nova/core";

const inputSchema = z.object({
  command: z.string().min(1).describe("The shell command to execute (run with `bash -lc`)"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(180_000)
    .default(180_000)
    .describe(
      "Timeout in milliseconds. Default and max 180000 (3 min). Anything that " +
        "might take longer should be launched with runInBackground instead.",
    ),
  cwd: z.string().optional().describe("Working directory; defaults to the nova session cwd."),
});

const MAX_OUTPUT = 200_000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n…(truncated ${s.length - MAX_OUTPUT} bytes)`;
}

/** Spawn `command` via `bash -lc` and shape its result into a tool result. */
async function exec(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; annotate: (s: string) => string },
): Promise<ToolRunResult> {
  const { cwd, timeoutMs, signal, annotate } = opts;
  try {
    const result = await execa(command, {
      shell: "/bin/bash",
      cwd,
      timeout: timeoutMs,
      all: true,
      reject: false,
      ...(signal ? { cancelSignal: signal } : {}),
    });
    const out = truncate(annotate(result.all ?? ""));
    if (result.failed || (result.exitCode ?? 0) !== 0) {
      return {
        output: `exit=${result.exitCode ?? "?"} ${result.signal ? `signal=${result.signal} ` : ""}\n${out}`,
        isError: true,
      };
    }
    return { output: out };
  } catch (err) {
    const e = err as ExecaError;
    return {
      output: `bash failed: ${e.shortMessage ?? e.message ?? String(err)}\n${annotate(typeof e.all === "string" ? e.all : "")}`,
      isError: true,
    };
  }
}

/**
 * Ask the user whether to re-run a sandbox-blocked command outside the sandbox.
 * Returns true only on an explicit confirmation; a missing askUser, a dismissed
 * prompt, or the "keep sandboxed" choice all return false.
 */
async function confirmUnsandboxedRerun(
  ctx: ToolContext,
  command: string,
  violations: string[],
): Promise<boolean> {
  if (!ctx.askUser) return false;
  const reason = violations.slice(0, 5).join("\n");
  const res = await ctx.askUser({
    questions: [
      {
        header: "Sandbox",
        question:
          `The command was blocked by the OS sandbox:\n\n${command}\n\n` +
          `Sandbox denials:\n${reason}\n\n` +
          "Re-run this command OUTSIDE the sandbox?",
        options: [
          {
            label: "Re-run unsandboxed",
            description: "Execute the command again with sandbox confinement lifted.",
          },
          {
            label: "Keep blocked",
            description: "Leave the command blocked and return the sandbox failure.",
          },
        ],
        multiSelect: false,
        // A yes/no decision — no freeform "Other" answer makes sense here.
        allowFreeform: false,
      },
    ],
  });
  if (res.cancelled) return false;
  const answer = res.answers[0];
  return answer?.selected.includes("Re-run unsandboxed") ?? false;
}

export const bashTool: ToolHandler = {
  definition: {
    name: "bash",
    description:
      "Execute a short, blocking shell command and return stdout+stderr. " +
      "Use for quick scripts, lookups, builds that finish in seconds, etc. " +
      "Hard cap is 3 minutes — for anything that might take longer (dev " +
      "servers, watchers, long builds, sleeps, downloads) use " +
      "runInBackground instead.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    const cwd = input.cwd ?? ctx.cwd;
    // Annotate against the ORIGINAL command — the sandbox keys violations by the
    // unwrapped command string. No-op when there are no violations.
    const annotate = (s: string): string =>
      ctx.sandbox ? ctx.sandbox.annotateOutput(input.command, s) : s;

    // No sandbox wired in: run the command directly.
    if (!ctx.sandbox) {
      return exec(input.command, { cwd, timeoutMs: input.timeout_ms, signal: ctx.signal, annotate });
    }

    // Confine the command before spawning. wrapCommand returns it unchanged when
    // sandboxing is inactive, so the no-sandbox path is unaffected. We still
    // execa with shell:/bin/bash — the wrapped string carries its own
    // sandbox-exec/bwrap invocation around an inner `/bin/bash -c`.
    const wrapped = await ctx.sandbox.wrapCommand(input.command, ctx.signal);
    let result: ToolRunResult;
    try {
      result = await exec(wrapped, { cwd, timeoutMs: input.timeout_ms, signal: ctx.signal, annotate });
    } finally {
      ctx.sandbox.afterCommand();
    }

    // If the OS sandbox blocked any filesystem/network access while the command
    // ran, degrade to the unsandboxed environment: ask the user whether to
    // re-run with confinement lifted, and on confirmation execute the ORIGINAL
    // (unwrapped) command once more. Keyed on recorded violations, NOT the exit
    // code — a denied write often still lets the command exit 0 (e.g. a
    // redirection failure swallowed by a trailing `; echo`, or a best-effort
    // write the script ignores), so an isError gate would miss it. The model
    // can't grant itself a sandbox escape, so the decision is the user's. With
    // no violations, no monitoring, or no way to ask, the result stands.
    const violations = ctx.sandbox.violationsForCommand(input.command);
    if (violations.length > 0 && (await confirmUnsandboxedRerun(ctx, input.command, violations))) {
      const rerun = await exec(input.command, {
        cwd,
        timeoutMs: input.timeout_ms,
        signal: ctx.signal,
        annotate: (s) => s,
      });
      return {
        output:
          "[sandbox] command was blocked by the OS sandbox; re-ran unsandboxed at the user's request.\n" +
          rerun.output,
        ...(rerun.isError ? { isError: true } : {}),
      };
    }
    return result;
  },
};
