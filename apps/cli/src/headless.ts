import type { MessageParam } from "@nova/core";
import type { Settings } from "@nova/runtime";
import { createContext, type CliRuntimeOptions } from "./context.js";
import { emitInit, registerHeadlessStream } from "./headless-events.js";
import { HeadlessScreen, type HeadlessApprovalPolicy } from "./headless-screen.js";
import { pruneOldSessions } from "./session.js";
import type { PermissionMode } from "./permissions.js";

/**
 * - `text`  — print only the final assistant text (default).
 * - `json`  — one JSON object with the run outcome plus the full `messages`
 *   trajectory (tool calls and results included).
 * - `jsonl` — stream one JSON event per line as each step happens, then a final
 *   `result` line. Best for eval harnesses that consume the run live.
 */
export type HeadlessOutputFormat = "text" | "json" | "jsonl";

export interface HeadlessOptions extends CliRuntimeOptions {
  prompt: string;
  outputFormat: HeadlessOutputFormat;
  permissionMode: PermissionMode;
  approvalPolicy: HeadlessApprovalPolicy;
}

/** Concatenate the text blocks of the last assistant message into a plain string. */
function finalAssistantText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    if (typeof msg.content === "string") return msg.content.trim();
    return msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
  return "";
}

/**
 * Run a single turn with no terminal attached and exit. Reuses the full agent
 * loop (hooks, permission engine, tools, sub-agents) via {@link HeadlessScreen};
 * nothing in the kernel is special-cased for headless.
 *
 * Returns the process exit code: 0 on success, 1 on turn failure/abort.
 */
export async function runHeadless(settings: Settings, opts: HeadlessOptions): Promise<number> {
  const screen = new HeadlessScreen({
    permissionMode: opts.permissionMode,
    approvalPolicy: opts.approvalPolicy,
  });

  const ctx = await createContext(settings, screen, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.continue !== undefined ? { continue: opts.continue } : {}),
    ...(opts.noTranscript !== undefined ? { noTranscript: opts.noTranscript } : {}),
    ...(opts.noPretty !== undefined ? { noPretty: opts.noPretty } : {}),
    ...(opts.thinkingLevelOverride !== undefined
      ? { thinkingLevelOverride: opts.thinkingLevelOverride }
      : {}),
    ...(opts.thinkingBudgetOverride !== undefined
      ? { thinkingBudgetOverride: opts.thinkingBudgetOverride }
      : {}),
  });

  // `jsonl` streams intermediate events live; register the hooks and emit the
  // opening `init` line before the turn starts so the trajectory is complete.
  const streaming = opts.outputFormat === "jsonl";
  const writeLine = (chunk: string): void => void process.stdout.write(chunk);
  if (streaming) {
    registerHeadlessStream(ctx, writeLine);
    emitInit(writeLine, ctx, opts.permissionMode);
  }

  let result;
  try {
    await pruneOldSessions(ctx);
    result = await ctx.agent.runTurn(opts.prompt);
  } finally {
    await ctx.transcript.flush();
    // A `-p` run's tokens count toward the all-time ledger like any other; its
    // batched writes need the same flush before the process exits.
    await ctx.screen.flushGlobalUsage();
    await ctx.backgroundManager.disposeAll();
    await ctx.monitorManager.disposeAll();
    if (ctx.lspManager) await ctx.lspManager.disposeAll();
    await ctx.sandbox.dispose();
    if (ctx.mcp) await ctx.mcp.close();
  }

  const text = finalAssistantText(result.messages);
  const errMsg = result.error ? result.error.message : result.aborted ? "aborted" : undefined;

  const outcome = {
    ok: result.ok,
    aborted: result.aborted,
    text,
    sessionId: ctx.session.id,
    turns: result.turns,
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    usage: result.totalUsage,
    ...(errMsg ? { error: errMsg } : {}),
  };

  if (opts.outputFormat === "jsonl") {
    // Close the stream with a single `result` line carrying the turn outcome;
    // the intermediate events already streamed during the run.
    process.stdout.write(`${JSON.stringify({ type: "result", ...outcome })}\n`);
  } else if (opts.outputFormat === "json") {
    // One object with the outcome plus the full trajectory (tool calls/results).
    const payload = { ...outcome, messages: result.messages };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    if (text) process.stdout.write(`${text}\n`);
    if (errMsg) process.stderr.write(`\n✗ ${errMsg}\n`);
  }

  return result.ok ? 0 : 1;
}
