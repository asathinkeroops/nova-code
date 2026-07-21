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
  /** Active tier alias (a key in `models`, e.g. "lite"/"pro"/"max"). */
  model: string;
  /** Concrete provider model id the tier resolves to (e.g. "deepseek-v4-pro"). */
  modelId?: string;
  cwd: string;
  home?: string;
  sessionId: string;
  contextWindowSize?: number;
  /** Thinking level label (e.g. "high", "max"), shown on the model line. */
  thinkingLabel?: string;
  /** Active provider id (e.g. "deepseek"), shown last on the model line. */
  provider?: string;
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
  | {
      kind: "thinking";
      key: string;
      thinking: string;
      label?: string;
      /** True once reasoning is done — eligible to collapse to a short preview. */
      collapsed?: boolean;
      /** User toggled the collapsed preview open to read the full reasoning. */
      expanded?: boolean;
    }
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
      /**
       * User toggled a body-bearing call (write/edit diff, bash command) open to
       * read its full body. Body-bearing calls collapse to a short preview once
       * done; the trailing hint is a click target keyed by this item's `key`.
       */
      expanded?: boolean;
    }
  | {
      kind: "tool-batch";
      key: string;
      /**
       * The consecutive completed tool calls folded into this batch, in order.
       * Rendered as a single summary line when {@link collapsed}, or as each
       * member's full tool-call rendering (exactly as if un-batched) when
       * expanded. See `coalesceToolBatches` and `renderToolBatch`.
       */
      members: Array<{ use: ToolUseBlock; result: ToolResultBlock | undefined }>;
      /** True = show only the summary line; false = show every member in full. */
      collapsed: boolean;
    }
  | { kind: "card"; key: string; card: Card };

/**
 * Tools whose adjacent calls fold into a collapsible batch: searches
 * (grep/glob), file reads, and shell runs. Pending calls fold too — the batch
 * forms as soon as the assistant message lands so the collapsed line stays
 * stable while results stream in, rather than re-flowing each time one arrives.
 * The summary marker reflects the aggregate state (pending / error / ok).
 */
const BATCHABLE_TOOLS = new Set(["grep", "glob", "read", "bash"]);

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
  /**
   * Set of batch keys (the first member's `tool_use` id) the user has expanded.
   * A coalesced tool batch renders collapsed unless its key is present here. See
   * `coalesceToolBatches`.
   */
  expandedItems?: Record<string, boolean>;
}

/**
 * Project store state into a flat list of RenderItems. Cards are interleaved
 * by their `anchor` (the message index they were pushed against); cards with
 * anchor === -1 render before all messages; cards anchored past the end go
 * last. Adjacent completed search/read/run tool calls are then folded into
 * collapsible `tool-batch` items (see `coalesceToolBatches`).
 */
export function buildRenderItems(opts: BuildOpts): RenderItem[] {
  const {
    banner,
    messages,
    cards,
    thinkingLabel,
    userDisplayOverrides,
    toolDetails,
    expandedItems,
  } = opts;
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
      appendAssistantItems(
        items,
        msg,
        resultIndex,
        thinkingLabel,
        nextKey,
        toolDetails,
        expandedItems ?? {},
      );
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

  return coalesceToolBatches(items, expandedItems ?? {});
}

type ToolCallItem = Extract<RenderItem, { kind: "tool-call" }>;

/** A grep/glob/read/bash call (pending or done) with no sub-agent details. */
function isBatchableToolCall(item: RenderItem | undefined): item is ToolCallItem {
  return (
    item !== undefined &&
    item.kind === "tool-call" &&
    BATCHABLE_TOOLS.has(item.use.name) &&
    (item.details === undefined || item.details.length === 0)
  );
}

/**
 * Fold maximal runs of consecutive search/read/run tool calls (pending or done)
 * into a single `tool-batch` item. In the flat item stream each tool call is preceded
 * by its own spacer, so a run looks like `[spacer, tool-call]+`; we keep the
 * run's leading spacer, drop the interior ones (the batch re-inserts blank rows
 * between members when expanded), and replace the rest with one batch item.
 * Runs shorter than two calls are left untouched. The batch key is the first
 * member's `tool_use` id — stable across appends, so its expand/collapse state
 * survives re-renders.
 */
function coalesceToolBatches(items: RenderItem[], expanded: Record<string, boolean>): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item && item.kind === "spacer" && isBatchableToolCall(items[i + 1])) {
      const members: Array<{ use: ToolUseBlock; result: ToolResultBlock | undefined }> = [];
      let j = i;
      while (items[j]?.kind === "spacer" && isBatchableToolCall(items[j + 1])) {
        const tc = items[j + 1] as ToolCallItem;
        members.push({ use: tc.use, result: tc.result });
        j += 2;
      }
      if (members.length >= 2) {
        const firstId = members[0]!.use.id;
        out.push(item); // keep the run's leading spacer
        out.push({
          kind: "tool-batch",
          key: firstId,
          members,
          collapsed: expanded[firstId] !== true,
        });
        i = j;
        continue;
      }
    }
    if (item) out.push(item);
    i++;
  }
  return out;
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
  // nova-injected messages (reminders, background-notifier notices, the
  // <compacted> boundary, goal-eval continuations) are read by the model but
  // never typed by the user — skip their bubbles. Identified structurally via
  // meta.synthetic, so a user who types a `<...>` tag still sees their message.
  // Compaction is instead announced via the `post_compact` info card.
  if (msg.meta?.synthetic) return;
  // Prefer the user's original typed input over the expanded model text for
  // slash commands that expand (e.g. `/agent`). Keyed by exact content.
  const display = (text: string): string => overrides?.[text] ?? text;
  if (typeof msg.content === "string") {
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
  expandedItems: Record<string, boolean>,
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
      // "✦ thinking" header with nothing under it. Mirrors the live-draft
      // guard in buildLiveDraftItems. `redacted_thinking` still renders: it
      // stands in for encrypted reasoning that genuinely exists.
      if (block.thinking.trim().length === 0) continue;
      const thKey = nextKey("th");
      push({
        kind: "thinking",
        key: thKey,
        thinking: block.thinking,
        // Committed thinking is "done": collapse it to a short preview. The
        // live draft (buildLiveDraftItems) stays uncollapsed so reasoning still
        // streams in full while it is being produced. The preview's "… +N lines"
        // hint is a click target (keyed by thKey) that expands the full text.
        collapsed: true,
        ...(expandedItems[thKey] ? { expanded: true } : {}),
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

      const details = toolDetails?.[block.id];
      const tcKey = nextKey("tc");
      push({
        kind: "tool-call",
        key: tcKey,
        use: block,
        result: resultIndex.get(block.id),
        ...(details && details.length > 0 ? { details } : {}),
        // A done body-bearing call (write/edit/bash) collapses to a preview; if
        // the user clicked its hint, `expandedItems` carries the key and we show
        // the full body. Mirrors the committed-thinking expand path above.
        ...(expandedItems[tcKey] ? { expanded: true } : {}),
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
