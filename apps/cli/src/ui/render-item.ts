import {
  blocksOf,
  extractText,
  type ContentBlock,
  type MessageParam,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@nova/core";
import type { BannerProps } from "./banner.js";
import type { Card } from "./store.js";

/**
 * A single visually-discrete chunk that the viewport renders. Stable identity
 * lets the measure cache key by reference. RenderItems are produced by
 * `buildRenderItems` from store state and then memoized.
 */
export type RenderItem =
  | { kind: "banner"; key: string; banner: BannerProps }
  | { kind: "spacer"; key: string }
  | { kind: "user-text"; key: string; text: string }
  | { kind: "assistant-text"; key: string; text: string }
  | { kind: "thinking"; key: string; thinking: string; label?: string }
  | { kind: "redacted-thinking"; key: string; label?: string }
  | {
      kind: "tool-call";
      key: string;
      use: ToolUseBlock;
      result: ToolResultBlock | undefined;
    }
  | {
      kind: "read-batch";
      key: string;
      entries: Array<{ use: ToolUseBlock; result: ToolResultBlock | undefined }>;
    }
  | { kind: "card"; key: string; card: Card };

const HIDDEN_TOOLS = new Set([
  "createTodo",
  "updateTodo",
  "getTodoList",
  "clearTodoList",
  "createTask",
  "updateTask",
  "getTask",
  "getTaskList",
  "clearTaskList",
  "checkLongRunningCommand",
]);

/**
 * Hook-injected user-role messages (todo/task reminders, long-running command
 * notifications) wrap their payload in a known tag so we can skip rendering
 * them as user bubbles.
 */
function isSystemInjectionText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<reminder>") ||
    trimmed.startsWith("<long-running-command")
  );
}

function buildResultIndex(messages: MessageParam[]): Map<string, ToolResultBlock> {
  const idx = new Map<string, ToolResultBlock>();
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") idx.set(b.tool_use_id, b);
    }
  }
  return idx;
}

export interface BuildOpts {
  banner: BannerProps | null;
  messages: MessageParam[];
  cards: Card[];
  thinkingLabel?: string;
}

/**
 * Project store state into a flat list of RenderItems. Cards are interleaved
 * by their `anchor` (the message index they were pushed against); cards with
 * anchor === -1 render before all messages; cards anchored past the end go
 * last. Adjacent `read` tool calls collapse into a single ReadBatch.
 */
export function buildRenderItems(opts: BuildOpts): RenderItem[] {
  const { banner, messages, cards, thinkingLabel } = opts;
  const items: RenderItem[] = [];
  let n = 0;
  const nextKey = (prefix: string): string => `${prefix}#${n++}`;

  if (banner) {
    items.push({ kind: "banner", key: nextKey("banner"), banner });
  }

  const cardsByAnchor = new Map<number, Card[]>();
  for (const c of cards) {
    const arr = cardsByAnchor.get(c.anchor);
    if (arr) arr.push(c);
    else cardsByAnchor.set(c.anchor, [c]);
  }

  for (const c of cardsByAnchor.get(-1) ?? []) {
    items.push({ kind: "spacer", key: nextKey("sp") });
    items.push({ kind: "card", key: `card#${c.id}`, card: c });
  }

  const resultIndex = buildResultIndex(messages);

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg) continue;

    if (msg.role === "user") {
      appendUserItems(items, msg, nextKey);
    } else {
      appendAssistantItems(items, msg, resultIndex, thinkingLabel, nextKey);
    }

    for (const c of cardsByAnchor.get(mi) ?? []) {
      items.push({ kind: "spacer", key: nextKey("sp") });
      items.push({ kind: "card", key: `card#${c.id}`, card: c });
    }
  }

  for (const c of cards) {
    if (c.anchor >= messages.length) {
      items.push({ kind: "spacer", key: nextKey("sp") });
      items.push({ kind: "card", key: `card#${c.id}`, card: c });
    }
  }

  return items;
}

/**
 * Render items for the in-flight streaming draft — the reasoning (if any) then
 * the visible answer, using the same `thinking` / `assistant-text` kinds as a
 * committed message so the swap to the final message is seamless. Returned as a
 * separate list (not folded into `buildRenderItems`) so the transcript's
 * measure-cache stays warm while only the draft re-renders each token.
 */
export function buildLiveDraftItems(
  draft: { text: string; thinking: string },
  thinkingLabel?: string,
): RenderItem[] {
  const items: RenderItem[] = [];
  if (draft.thinking.trim().length > 0) {
    items.push({ kind: "spacer", key: "live-th-sp" });
    items.push({
      kind: "thinking",
      key: "live-th",
      thinking: draft.thinking,
      ...(thinkingLabel !== undefined ? { label: thinkingLabel } : {}),
    });
  }
  if (draft.text.trim().length > 0) {
    items.push({ kind: "spacer", key: "live-at-sp" });
    items.push({ kind: "assistant-text", key: "live-at", text: draft.text });
  }
  return items;
}

function appendUserItems(
  items: RenderItem[],
  msg: MessageParam,
  nextKey: (p: string) => string,
): void {
  if (typeof msg.content === "string") {
    if (isSystemInjectionText(msg.content)) return;
    items.push({ kind: "spacer", key: nextKey("sp") });
    items.push({
      kind: "user-text",
      key: nextKey("user"),
      text: msg.content,
    });
    return;
  }
  for (const b of msg.content) {
    if (b.type !== "text") continue;
    if (b.text.trim().length === 0) continue;
    if (isSystemInjectionText(b.text)) continue;
    items.push({ kind: "spacer", key: nextKey("sp") });
    items.push({ kind: "user-text", key: nextKey("user"), text: b.text });
  }
}

function appendAssistantItems(
  items: RenderItem[],
  msg: MessageParam,
  resultIndex: Map<string, ToolResultBlock>,
  thinkingLabel: string | undefined,
  nextKey: (p: string) => string,
): void {
  const blocks = blocksOf(msg);
  // Each visible item gets a leading spacer so consecutive tools / thinking
  // / assistant-text rows are separated by a blank line. Spacer is owned by
  // the item rather than the section so the layout stays consistent
  // regardless of which item type comes first.
  const push = (item: RenderItem): void => {
    items.push({ kind: "spacer", key: nextKey("sp") });
    items.push(item);
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as ContentBlock;
    if (block.type === "thinking") {
      push({
        kind: "thinking",
        key: nextKey("th"),
        thinking: block.thinking,
        ...(thinkingLabel !== undefined ? { label: thinkingLabel } : {}),
      });
    } else if (block.type === "redacted_thinking") {
      push({
        kind: "redacted-thinking",
        key: nextKey("rth"),
        ...(thinkingLabel !== undefined ? { label: thinkingLabel } : {}),
      });
    } else if (block.type === "tool_use") {
      if (HIDDEN_TOOLS.has(block.name)) continue;

      if (block.name === "read") {
        const entries = [{ use: block, result: resultIndex.get(block.id) }];
        let j = i + 1;
        while (j < blocks.length) {
          const next = blocks[j];
          if (
            !next ||
            next.type !== "tool_use" ||
            next.name !== "read" ||
            HIDDEN_TOOLS.has(next.name)
          ) {
            break;
          }
          entries.push({ use: next, result: resultIndex.get(next.id) });
          j++;
        }
        if (entries.length >= 2) {
          push({
            kind: "read-batch",
            key: nextKey("rb"),
            entries,
          });
          i = j - 1;
          continue;
        }
      }

      push({
        kind: "tool-call",
        key: nextKey("tc"),
        use: block,
        result: resultIndex.get(block.id),
      });
    }
  }

  const text = extractText(blocks);
  if (text.trim().length > 0) {
    push({
      kind: "assistant-text",
      key: nextKey("at"),
      text,
    });
  }
}
