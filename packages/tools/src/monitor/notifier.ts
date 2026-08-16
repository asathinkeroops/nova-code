import {
  markSynthetic,
  type MessageParam,
  type ToolDefinition,
} from "@nova/core";
import {
  xmlAttr,
  xmlEscape,
} from "@nova/runtime";
import type { MonitorEvents, MonitorManager } from "./manager.js";

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

export type MonitorNotifierHook = (
  payload: PreRequestPayload,
) => Promise<PreRequestOverride | undefined> | PreRequestOverride | undefined;

/**
 * Render one monitor's batch. Unlike a background command's completion notice —
 * which points at a log file — the event lines ARE inlined, because there is no
 * other channel for them: the whole point of a monitor is that the model is told
 * what happened without having to go look. The volume risk that argues against
 * inlining elsewhere is handled at the source instead, by the manager's rate
 * limit and queue cap.
 */
function renderEvents(e: MonitorEvents): string {
  const parts: string[] = [];
  if (e.droppedEvents > 0) {
    parts.push(`[dropped ${e.droppedEvents} older events — the watch outran the agent]`);
  }
  parts.push(...e.lines);
  if (e.status !== undefined) {
    parts.push(`[monitor ${e.status}${e.reason !== undefined ? `: ${e.reason}` : ""}]`);
  }
  const status = e.status !== undefined ? ` status="${xmlAttr(e.status)}"` : "";
  return (
    `<monitor-notification id="${xmlAttr(e.id)}" watching="${xmlAttr(e.description)}"` +
    `${status}>${xmlEscape(parts.join("\n"))}</monitor-notification>`
  );
}

/**
 * Returns a `pre_request` hook that drains every monitor's queued events and
 * appends one user message carrying them. Because `pre_request` persists
 * `messages` overrides, the injection stays in canonical history — so events
 * are delivered exactly once, which is why {@link MonitorManager.takeEvents}
 * consumes them.
 */
export function makeMonitorNotifier(manager: MonitorManager): MonitorNotifierHook {
  return ({ messages }) => {
    const ids = manager.drainPending();
    if (ids.length === 0) return undefined;

    const rendered: string[] = [];
    for (const id of ids) {
      const events = manager.takeEvents(id);
      if (!events) continue;
      rendered.push(renderEvents(events));
    }
    if (rendered.length === 0) return undefined;

    const injection = markSynthetic(
      { role: "user", content: [{ type: "text", text: rendered.join("\n") }] },
      "monitor-notification",
    );
    return { messages: [...messages, injection] };
  };
}
