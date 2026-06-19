import {
  blocksOf,
  type ContentBlock,
  type MessageParam,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@nova/core";
import type { SubAgentDetail } from "@nova/subagent";
import type { Card } from "./store.js";

/** Data needed to render the startup banner (logo + session metadata). */
export interface BannerProps {
  version: string;
  model: string;
  cwd: string;
  home?: string;
  sessionId: string;
  contextWindowSize?: number;
  /** Thinking level label (e.g. "high", "max"), shown on the model line. */
  thinkingLabel?: string;
}

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
  | { kind: "thinking"; key: string; thinking: string; label?: string; collapsed?: boolean }
  | { kind: "redacted-thinking"; key: string; label?: string }
  | {
      kind: "tool-call";
      key: string;
      use: ToolUseBlock;
      result: ToolResultBlock | undefined;
      /**
       * Display-only progress details for a sub-agent run (latest few), shown
       * under the tool-call card. Present only for `createSubAgent` calls that
       * have recorded details. See `display-sidecar.ts`.
       */
      details?: SubAgentDetail[];
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
  "getTaskList",
  "clearTaskList",
]);

/**
 * Hook-injected user-role messages (todo/task reminders, background command
 * notifications) wrap their payload in a known tag so we can skip rendering
 * them as user bubbles.
 */
function isSystemInjectionText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<reminder>") ||
    trimmed.startsWith("<background-command") ||
    trimmed.startsWith("<interrupted-by-user>")
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
  /**
   * Map of expanded-model-text → original user input for slash commands that
   * expand into a longer prompt (e.g. `/agent`). When a user message's text
   * matches a key, the renderer shows the original input instead. See
   * `display-sidecar.ts`.
   */
  userDisplayOverrides?: Record<string, string>;
  /**
   * Map of parent `tool_use` id → latest sub-agent progress details. Attached
   * to the matching tool-call item so the renderer can show them. See
   * `display-sidecar.ts`.
   */
  toolDetails?: Record<string, SubAgentDetail[]>;
}

/**
 * Project store state into a flat list of RenderItems. Cards are interleaved
 * by their `anchor` (the message index they were pushed against); cards with
 * anchor === -1 render before all messages; cards anchored past the end go
 * last. Adjacent `read` tool calls collapse into a single ReadBatch.
 */
export function buildRenderItems(opts: BuildOpts): RenderItem[] {
  const { banner, messages, cards, thinkingLabel, userDisplayOverrides, toolDetails } =
    opts;
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
      appendUserItems(items, msg, nextKey, userDisplayOverrides);
    } else {
      appendAssistantItems(items, msg, resultIndex, thinkingLabel, nextKey, toolDetails);
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
  overrides: Record<string, string> | undefined,
): void {
  // Prefer the user's original typed input over the expanded model text for
  // slash commands that expand (e.g. `/agent`). Keyed by exact content.
  const display = (text: string): string => overrides?.[text] ?? text;
  if (typeof msg.content === "string") {
    if (isSystemInjectionText(msg.content)) return;
    items.push({ kind: "spacer", key: nextKey("sp") });
    items.push({
      kind: "user-text",
      key: nextKey("user"),
      text: display(msg.content),
    });
    return;
  }
  for (const b of msg.content) {
    if (b.type !== "text") continue;
    if (b.text.trim().length === 0) continue;
    if (isSystemInjectionText(b.text)) continue;
    items.push({ kind: "spacer", key: nextKey("sp") });
    items.push({ kind: "user-text", key: nextKey("user"), text: display(b.text) });
  }
}

function appendAssistantItems(
  items: RenderItem[],
  msg: MessageParam,
  resultIndex: Map<string, ToolResultBlock>,
  thinkingLabel: string | undefined,
  nextKey: (p: string) => string,
  toolDetails: Record<string, SubAgentDetail[]> | undefined,
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
      // Skip empty thinking blocks (a pure tool-call turn where the model
      // produced no reasoning) — otherwise they render as a dangling
      // "✻ thinking" header with nothing under it. Mirrors the live-draft
      // guard in buildLiveDraftItems. `redacted_thinking` still renders: it
      // stands in for encrypted reasoning that genuinely exists.
      if (block.thinking.trim().length === 0) continue;
      push({
        kind: "thinking",
        key: nextKey("th"),
        thinking: block.thinking,
        // Committed thinking is "done": collapse it to a short preview. The
        // live draft (buildLiveDraftItems) stays uncollapsed so reasoning still
        // streams in full while it is being produced.
        collapsed: true,
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

      const details = toolDetails?.[block.id];
      push({
        kind: "tool-call",
        key: nextKey("tc"),
        use: block,
        result: resultIndex.get(block.id),
        ...(details && details.length > 0 ? { details } : {}),
      });
    } else if (block.type === "text") {
      // Render text at its real position in the block stream so "narrate then
      // act" turns (text before tool_use in the same message) keep their order.
      // Skip empty text blocks — a pure tool-call turn often carries one.
      if (block.text.trim().length === 0) continue;
      push({
        kind: "assistant-text",
        key: nextKey("at"),
        text: block.text,
      });
    }
  }
}
