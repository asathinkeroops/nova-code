import type {
  ContentBlock,
  MessageMeta,
  MessageParam,
  SyntheticKind,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

export function userText(text: string, meta?: MessageMeta): MessageParam {
  return meta ? { role: "user", content: text, meta } : { role: "user", content: text };
}

/**
 * Stamp the out-of-band synthetic marker on a nova-injected message. The in-band
 * `<...>` tag stays in `content` for the model to read; `meta` is what the TUI
 * (bubble hiding) and the compaction slice (boundary detection) actually key
 * off, so those decisions no longer depend on matching user-forgeable strings.
 */
export function markSynthetic(msg: MessageParam, kind: SyntheticKind): MessageParam {
  return { ...msg, meta: { synthetic: true, kind } };
}

/**
 * Project canonical messages to the wire shape sent to the model gateway:
 * `{ role, content }` only. Strips nova-internal fields (notably `meta`) so the
 * request body stays byte-identical to the pre-`meta` format — the single scrub
 * point between append-only canonical history and the SDK, which preserves
 * DeepSeek prefix-cache hits. Applied at the model boundary so EVERY call is
 * covered (the agent's sliced client AND the unwrapped summarizer client).
 */
export function toWireMessages(messages: MessageParam[]): MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Pre-`meta` synthetic-injection tags → kind. Used ONLY to upgrade sessions
 * persisted before `meta` existed (see `migrateLegacyMeta`); live injections set
 * `meta` directly, so runtime control flow never string-matches these.
 */
const LEGACY_TAG_KINDS: ReadonlyArray<readonly [string, SyntheticKind]> = [
  ["<todo-reminder>", "todo-reminder"],
  ["<task-reminder>", "task-reminder"],
  // Pre-split sessions used a shared `<reminder>` for both todo and task nudges;
  // the subtype drives nothing (both merely hide), so map to todo-reminder.
  ["<reminder>", "todo-reminder"],
  ["<background-notifier", "background-notifier"],
  // Pre-rename sessions used `<background-command …>` for the same notification.
  ["<background-command", "background-notifier"],
  ["<interrupted-by-user>", "interrupted"],
  ["<goal-eval>", "goal-eval"],
  ["<compacted>", "compacted"],
];

/**
 * Back-fill `meta` on a message loaded from a session written before the field
 * existed, by matching its legacy opening tag. New messages already carry `meta`,
 * so this is a one-way, load-time upgrade for old transcripts only — it keeps
 * their compaction boundaries sliceable and their reminder bubbles hidden.
 */
export function migrateLegacyMeta(msg: MessageParam): MessageParam {
  if (msg.meta || msg.role !== "user") return msg;
  const text =
    typeof msg.content === "string"
      ? msg.content
      : msg.content.length === 1 && msg.content[0]?.type === "text"
        ? msg.content[0].text
        : undefined;
  if (text === undefined) return msg;
  const trimmed = text.trimStart();
  for (const [tag, kind] of LEGACY_TAG_KINDS) {
    if (trimmed.startsWith(tag)) return { ...msg, meta: { synthetic: true, kind } };
  }
  return msg;
}

export function assistantMessage(content: ContentBlock[]): MessageParam {
  return { role: "assistant", content };
}

export function userToolResults(results: ToolResultBlock[]): MessageParam {
  return { role: "user", content: results };
}

export function appendMessage(history: MessageParam[], next: MessageParam): MessageParam[] {
  return [...history, next];
}

export function blocksOf(message: MessageParam): ContentBlock[] {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  return message.content;
}

export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function extractToolUses(blocks: ContentBlock[]): ToolUseBlock[] {
  return blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function extractThinking(blocks: ContentBlock[]): ThinkingBlock[] {
  return blocks.filter((b): b is ThinkingBlock => b.type === "thinking");
}

export function serializeForTranscript(message: MessageParam): MessageParam {
  return JSON.parse(JSON.stringify(message)) as MessageParam;
}
