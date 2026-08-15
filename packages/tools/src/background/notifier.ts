import {
  markSynthetic,
  xmlAttr,
  xmlEscape,
  type MessageParam,
  type ToolDefinition,
} from "@nova/core";
import type { CompletionNotice, BackgroundCommandManager } from "./manager.js";

interface PreRequestPayload {
  system: string;
  messages: MessageParam[];
  tools: ToolDefinition[];
  maxTokens: number;
  thinkingBudgetTokens?: number;
}

interface PreRequestOverride {
  messages?: MessageParam[];
}

export type BackgroundNotifierHook = (
  payload: PreRequestPayload,
) => Promise<PreRequestOverride | undefined> | PreRequestOverride | undefined;

/**
 * Render one finished command as an announcement, NOT as an output delivery:
 * the element body carries the exit reason and a pointer to the log, and the
 * output itself stays in the file at `output` for the model to `read`/`grep` if
 * it cares. See {@link CompletionNotice} for why re-delivering it here would be
 * a second channel for bytes the model may already have read.
 */
function renderRecord(r: CompletionNotice): string {
  const lines: string[] = [];
  if (r.reason !== undefined) lines.push(`[${r.reason}]`);
  if (r.outputPath !== undefined) {
    lines.push(`Output: ${r.outputPath} — read or grep it if you need the command's output.`);
  } else if (r.inlineOutput) {
    // No log file configured, so this notice is the only channel for the output.
    lines.push(r.inlineOutput);
  }
  const output = r.outputPath !== undefined ? ` output="${xmlAttr(r.outputPath)}"` : "";
  const body = xmlEscape(lines.join("\n"));
  return (
    `<background-notification id="${xmlAttr(r.id)}" command="${xmlAttr(r.command)}"` +
    ` status="${xmlAttr(r.status)}"${output}>${body}</background-notification>`
  );
}

/**
 * Returns a `pre_request` hook handler that drains the manager's completion
 * queue and appends a single user message announcing every finished command to
 * the request's `messages`. Because `pre_request` persists `messages`
 * overrides, the injection stays in canonical history — which is the other
 * reason it stays metadata-only: an inlined megabyte of dev-server log would be
 * there permanently.
 */
export function makeBackgroundNotifier(manager: BackgroundCommandManager): BackgroundNotifierHook {
  return ({ messages }) => {
    const ids = manager.drainNotifications();
    if (ids.length === 0) return undefined;

    const rendered: string[] = [];
    for (const id of ids) {
      const notice = manager.completionNotice(id);
      if (!notice) continue;
      rendered.push(renderRecord(notice));
    }
    if (rendered.length === 0) return undefined;

    const text = rendered.join("\n");
    const injection = markSynthetic(
      { role: "user", content: [{ type: "text", text }] },
      "background-notification",
    );
    return { messages: [...messages, injection] };
  };
}
