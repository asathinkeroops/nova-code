import type { MessageParam, SyntheticKind } from "@nova/core";
import type { Settings } from "@nova/base";
import { createContext, type CliRuntimeOptions } from "./context.js";
import { emitInit, registerHeadlessStream } from "./headless-events.js";
import { HeadlessScreen, type HeadlessApprovalPolicy } from "./headless-screen.js";
import { pruneOldSessions, type ResolvedSession } from "./session.js";
import type { PermissionMode } from "./permissions.js";

/**
 * - `text`  — print only the final assistant text (default).
 * - `json`  — one JSON object with the run outcome plus the replayable
 *   `messages` trajectory (tool calls and results included; internal hints
 *   filtered, execution evidence kept — see {@link replayableMessages}).
 * - `jsonl` — stream one JSON event per line as each step happens, then a final
 *   `result` line. Best for eval harnesses that consume the run live.
 */
export type HeadlessOutputFormat = "text" | "json" | "jsonl";

export interface HeadlessOptions extends CliRuntimeOptions {
  /**
   * Session + checkout resolved BEFORE the trust gate (see `resolveLaunchTarget`).
   * The host passes it so nothing here re-resolves into a different directory.
   */
  target?: ResolvedSession;
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
 * Synthetic kinds that are EXECUTION EVIDENCE rather than internal guidance and
 * therefore stay in the exported trajectory:
 *
 * - `monitor-notification` — the only carrier of a monitor's event lines; there
 *   is no corresponding `tool_result`.
 * - `background-notification` — the only notice that a command finished, and
 *   (when no log file is configured) the only carrier of its output.
 * - `shell-escape` — the output of a user-typed `!cmd`, which becomes model
 *   input on the next turn; dropping it removes what the model actually read.
 * - `compacted` — structural: dropping the boundary would make the retained
 *   pre-boundary history look as if it had been fed to the model.
 *
 * Everything else — the skills index, todo/task reminders, plan-mode notices,
 * interruption/continuation markers, goal-eval and stop-hook prompts — is
 * internal context. It stays in `messages.jsonl` / `transcript.jsonl` for
 * replay, but must not leak into an eval harness's JSON (the skills index in
 * particular carries paths and project-specific notes).
 */
const REPLAYABLE_SYNTHETIC_KINDS: ReadonlySet<SyntheticKind> = new Set([
  "compacted",
  "monitor-notification",
  "background-notification",
  "shell-escape",
]);

export function replayableMessages(messages: MessageParam[]): MessageParam[] {
  return messages.filter(
    (message) => !message.meta?.synthetic || REPLAYABLE_SYNTHETIC_KINDS.has(message.meta.kind),
  );
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

  const ctx = await createContext(
    settings,
    screen,
    {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
      ...(opts.continue !== undefined ? { continue: opts.continue } : {}),
      ...(opts.noTranscript !== undefined ? { noTranscript: opts.noTranscript } : {}),
      ...(opts.noPretty !== undefined ? { noPretty: opts.noPretty } : {}),
      ...(opts.thinkingLevelOverride !== undefined
        ? { thinkingLevelOverride: opts.thinkingLevelOverride }
        : {}),
    },
    opts.target,
  );

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
    // One object with the outcome plus the replayable trajectory. Injections
    // (reminders, notifications, the skills index) are internal context, not
    // part of the public output; the compaction boundary is retained.
    const payload = { ...outcome, messages: replayableMessages(result.messages) };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    if (text) process.stdout.write(`${text}\n`);
    if (errMsg) process.stderr.write(`\n✗ ${errMsg}\n`);
  }

  return result.ok ? 0 : 1;
}
