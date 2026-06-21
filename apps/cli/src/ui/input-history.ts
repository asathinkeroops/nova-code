import { COMPACT_MARKER } from "@nova/context";
import type { MessageParam } from "@nova/core";

/**
 * User-typed prompts for InputBox ↑/↓ recall, oldest first. Only plain-string
 * user messages survive — tool_results, todo/task reminders, and background
 * command notifiers all use block-array content, and the auto-compaction summary
 * (a string message) is dropped by its `[Conversation compacted …]` header.
 * Goal-eval auto-continuations are plain strings too, so they are dropped by
 * their `<goal-eval>` wrapper — the user never typed them.
 */
export function userInputHistory(messages: MessageParam[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    if (m.content.startsWith(`[Conversation compacted ${COMPACT_MARKER}`)) continue;
    if (m.content.trimStart().startsWith("<goal-eval>")) continue;
    out.push(m.content);
  }
  return out;
}
