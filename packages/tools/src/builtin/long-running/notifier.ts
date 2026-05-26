import { xmlAttr, xmlEscape, type MessageParam, type ToolDefinition } from "@nova/core";
import type { CommandRecord, LongRunningCommandManager } from "./manager.js";

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

export type LongRunningNotifierHook = (
  payload: PreRequestPayload,
) => Promise<PreRequestOverride | undefined> | PreRequestOverride | undefined;

function renderRecord(r: CommandRecord): string {
  const body = xmlEscape(r.result ?? "no data");
  return (
    `<long-running-command id="${xmlAttr(r.id)}" command="${xmlAttr(r.command)}"` +
    ` status="${xmlAttr(r.status)}">${body}</long-running-command>`
  );
}

/**
 * Returns a `pre_request` hook handler that drains the manager's completion
 * queue and appends a single user message describing every finished command
 * to the request's `messages`. Because `pre_request` persists `messages`
 * overrides, the injection stays in canonical history.
 */
export function makeLongRunningNotifier(
  manager: LongRunningCommandManager,
): LongRunningNotifierHook {
  return ({ messages }) => {
    const ids = manager.drainNotifications();
    if (ids.length === 0) return undefined;

    const rendered: string[] = [];
    for (const id of ids) {
      const record = manager.get(id);
      if (!record) continue;
      rendered.push(renderRecord(record));
    }
    if (rendered.length === 0) return undefined;

    const text = rendered.join("\n");
    const injection: MessageParam = {
      role: "user",
      content: [{ type: "text", text }],
    };
    return { messages: [...messages, injection] };
  };
}
