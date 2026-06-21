import type { ToolResultBlock } from "@nova/core";
import type { CliContext } from "./context.js";

/**
 * Streaming event output for headless runs (`--output-format jsonl`).
 *
 * The plain `text` format only surfaces the final answer, which hides the
 * trajectory an eval harness needs: what the model reasoned, which tools it
 * called with what inputs, and what each returned. This module taps the agent's
 * advisory hooks and writes one JSON object per line (JSONL) as each step lands
 * — no kernel changes, same loop, same single extension point. (`json` carries
 * the same trajectory in one shot via the final `messages` array; `jsonl`
 * streams it live.)
 *
 * Event shapes (one `type` per line, emitted in execution order):
 * - `{ type: "system", subtype: "init", sessionId, model, cwd, permissionMode }`
 * - `{ type: "thinking", text }`               extended-thinking block
 * - `{ type: "text", text }`                   assistant prose block
 * - `{ type: "tool_use", id, name, input }`    a tool call the model issued
 * - `{ type: "permission", tool, toolUseId, granted, reason? }`
 * - `{ type: "tool_result", toolUseId, name, isError, content }`
 * - `{ type: "result", ok, aborted, turns, stopReason?, usage, text, error? }`
 *
 * The final `result` event is emitted by {@link runHeadless}, not here, so it
 * can fold in the turn outcome; everything before it streams live.
 */
export type StreamWrite = (chunk: string) => void;

function emit(write: StreamWrite, event: Record<string, unknown>): void {
  write(`${JSON.stringify(event)}\n`);
}

/** Flatten a tool_result's content into a plain string (images become a marker). */
function flattenToolContent(content: ToolResultBlock["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : "[image]")).join("");
}

/** Emit the opening `system/init` event describing the run. */
export function emitInit(
  write: StreamWrite,
  ctx: CliContext,
  permissionMode: string,
): void {
  emit(write, {
    type: "system",
    subtype: "init",
    sessionId: ctx.session.id,
    model: ctx.settings.model,
    cwd: ctx.workspace,
    permissionMode,
  });
}

/**
 * Register the advisory hooks that stream intermediate events. All hooks here
 * are pure notifications (return undefined), so blocking points like
 * `post_tool_use` stay non-decisive and the loop is unaffected.
 */
export function registerHeadlessStream(ctx: CliContext, write: StreamWrite): void {
  // One event per content block, in order, so the trajectory is reconstructable.
  ctx.agent.on("post_assistant", (turn) => {
    for (const block of turn.content) {
      if (block.type === "thinking") {
        emit(write, { type: "thinking", text: block.thinking });
      } else if (block.type === "text") {
        emit(write, { type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        emit(write, {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
  });

  // Surface permission outcomes — denials are the usual reason a headless run
  // stalls or refuses, so an eval needs to see them distinctly from tool errors.
  ctx.agent.on("post_permission", ({ tool, toolUseId, granted, reason }) => {
    emit(write, {
      type: "permission",
      tool,
      toolUseId,
      granted,
      ...(reason ? { reason } : {}),
    });
  });

  // `post_tool_use` is a blocking point; returning undefined keeps it advisory.
  ctx.agent.on("post_tool_use", ({ use, result }) => {
    emit(write, {
      type: "tool_result",
      toolUseId: result.tool_use_id,
      name: use.name,
      isError: result.is_error ?? false,
      content: flattenToolContent(result.content),
    });
  });
}
