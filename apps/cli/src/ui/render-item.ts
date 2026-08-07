import {
  blocksOf,
  type ContentBlock,
  type MessageParam,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@nova/core";
import { aliasedPath, EXIT_PLAN_MODE_TOOL } from "@nova/tools";
import type { SubAgentDetail } from "@nova/subagent";
import { readExisting } from "./diff.js";
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
      /**
       * For a `write` call only: the target file's content as it was BEFORE the
       * write, so the renderer can diff against it. `null` means the file did not
       * exist (a create); absent for every other tool. Captured here rather than
       * read by the renderer — see {@link writeBaseline}.
       */
      baseline?: string | null;
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

/**
 * Tools whose call rows are dropped from the transcript because the UI already
 * shows their effect somewhere better — the todo and task lists each render as
 * their own footer. Skipping the `tool_use` skips its result too: results are
 * only ever drawn as part of the call that produced them.
 *
 * Neither plan-mode tool is listed. `enterPlanMode` renders as a short `plan`
 * row (render-strings.ts) marking where the session went read-only, and
 * `exitPlanMode` is replaced by the plan it carries (see {@link planToRender}).
 */
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
 * The plan to draw in place of a hidden `exitPlanMode` row, or null to draw
 * nothing at all.
 *
 * Null when the same message already spells the plan out as prose: a turn that
 * narrates the plan and *also* passes a copy to the tool would otherwise print
 * it twice, which is the duplication hiding the row was meant to end. The check
 * is verbatim containment, so it can only fire on an actual copy — a short
 * lead-in like "方案如下" does not contain the plan and the plan still renders.
 */
function planToRender(block: ToolUseBlock, blocks: readonly ContentBlock[]): string | null {
  const plan = (block.input as { plan?: unknown } | null | undefined)?.plan;
  if (typeof plan !== "string") return null;
  const trimmed = plan.trim();
  if (trimmed.length === 0) return null;
  for (const b of blocks) {
    if (b.type === "text" && b.text.includes(trimmed)) return null;
  }
  return trimmed;
}

// ─── item interning ─────────────────────────────────────────────────────────

/**
 * Previously built items, keyed by their stable {@link RenderItem.key}.
 *
 * `buildRenderItems` runs on every store update, and the loop fires
 * `post_messages` roughly `2 × toolCalls + 3` times per turn. The line cache in
 * `measure.ts` is keyed by item IDENTITY, and a miss there re-runs markdown
 * highlighting, diff rendering and ANSI wrapping for that item — so handing back
 * freshly allocated items re-measured the WHOLE transcript on every one of those
 * fires (tens of ms per fire, growing with history length).
 *
 * The objects items render from are reference-stable: `messages` is append-only,
 * and the loop's in-place message replacements (progressive tool_use reveal,
 * incremental tool_result commits) rebuild the MessageParam from the SAME
 * ContentBlock objects. So each item is cached under its key and the previous
 * instance is returned whenever every input it renders from is still identical,
 * which keeps the measure cache warm across rebuilds.
 *
 * Inputs are compared by reference, never by content: deep-comparing e.g. a long
 * assistant text would cost about as much as the re-measure it avoids.
 */
const interned = new Map<string, { deps: readonly unknown[]; item: RenderItem }>();

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Per-build state: the interning bookkeeping plus the lookup tables the item
 * builders need. Threaded through the `append*` helpers instead of a growing
 * positional parameter list.
 */
interface BuildCtx {
  /** Keys produced by the current build, used to prune the cache afterwards. */
  used: Set<string>;
  resultIndex: Map<string, ToolResultBlock>;
  thinkingLabel: string | undefined;
  overrides: Record<string, string> | undefined;
  toolDetails: Record<string, SubAgentDetail[]> | undefined;
  expandedItems: Record<string, boolean>;
}

/**
 * Return the cached item for `key` when every entry of `deps` is still
 * reference-identical; otherwise build it with `make` and cache that. `deps`
 * must name every input the item renders from — by convention the source
 * block / message / card first, then the derived state (result, details, flags).
 */
function intern<T extends RenderItem>(
  ctx: BuildCtx,
  key: string,
  deps: readonly unknown[],
  make: () => T,
): T {
  ctx.used.add(key);
  const hit = interned.get(key);
  if (hit && sameDeps(hit.deps, deps)) return hit.item as T;
  const item = make();
  interned.set(key, { deps, item });
  return item;
}

/** Push `item` behind its own blank-line spacer (interned alongside it). */
function pushWithSpacer(items: RenderItem[], ctx: BuildCtx, item: RenderItem): void {
  const key = `sp:${item.key}`;
  items.push(intern(ctx, key, [], () => ({ kind: "spacer", key })));
  items.push(item);
}

// ─── write baseline ─────────────────────────────────────────────────────────

/**
 * The target file's pre-write content for a `write` tool_use, read at most once
 * per block.
 *
 * The renderer must NOT read the file itself. It re-renders long after the tool
 * has run, so by then the file holds the content being written and the diff
 * degrades into `- new / + new` — the scrollback silently rewrites itself into a
 * bogus diff. Reading here instead pins the baseline to the first time the block
 * is seen, which is the `post_messages` that reveals the tool_use — before the
 * loop has executed it. `null` means the file did not exist (a create).
 *
 * A transcript loaded from disk (`/resume`) is first seen with its results
 * already in place, so the only baseline obtainable is the post-write content;
 * the renderer detects `baseline === content` and shows the written file rather
 * than a diff of it against itself.
 */
const writeBaselines = new WeakMap<ToolUseBlock, string | null>();

function writeBaseline(block: ToolUseBlock): string | null {
  const hit = writeBaselines.get(block);
  if (hit !== undefined) return hit;
  const path = aliasedPath(block.input);
  const existing = path ? readExisting(path) : null;
  writeBaselines.set(block, existing);
  return existing;
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
  // Item keys are derived from the message/block position or the card id rather
  // than a running counter: a counter shifts every later key when an anchored
  // card is inserted or a hidden tool is skipped, which both breaks the
  // `expandedItems` mapping (a collapse state jumps to a different item) and
  // defeats interning. Positions never shift — the history is append-only.
  const ctx: BuildCtx = {
    used: new Set<string>(),
    resultIndex: buildResultIndex(messages),
    thinkingLabel,
    overrides: userDisplayOverrides,
    toolDetails,
    expandedItems: expandedItems ?? {},
  };

  if (banner) {
    items.push(intern(ctx, "banner", [banner], () => ({ kind: "banner", key: "banner", banner })));
  }

  const cardsByAnchor = new Map<number, Card[]>();
  for (const c of cards) {
    const arr = cardsByAnchor.get(c.anchor);
    if (arr) arr.push(c);
    else cardsByAnchor.set(c.anchor, [c]);
  }

  const pushCard = (c: Card): void => {
    const key = `card#${c.id}`;
    pushWithSpacer(
      items,
      ctx,
      intern(ctx, key, [c], () => ({ kind: "card", key, card: c })),
    );
  };

  for (const c of cardsByAnchor.get(-1) ?? []) pushCard(c);

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg) continue;

    if (msg.role === "user") {
      appendUserItems(items, ctx, msg, mi);
    } else {
      appendAssistantItems(items, ctx, msg, mi);
    }

    for (const c of cardsByAnchor.get(mi) ?? []) pushCard(c);
  }

  for (const c of cards) {
    if (c.anchor >= messages.length) pushCard(c);
  }

  const out = coalesceToolBatches(items, ctx);

  // Drop entries this build didn't produce, so a truncated (`/rewind`) or
  // replaced (`/clear`, `/resume`) transcript can't leave the tail of the
  // previous one cached forever.
  if (interned.size > ctx.used.size) {
    for (const key of interned.keys()) {
      if (!ctx.used.has(key)) interned.delete(key);
    }
  }

  return out;
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
function coalesceToolBatches(items: RenderItem[], ctx: BuildCtx): RenderItem[] {
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
        const collapsed = ctx.expandedItems[firstId] !== true;
        // `members` is a fresh array every build, so the interning deps name each
        // member's blocks individually — the batch is unchanged as long as the
        // same uses and results are still folded into it.
        const deps: unknown[] = [collapsed];
        for (const m of members) deps.push(m.use, m.result);
        out.push(item); // keep the run's leading spacer
        out.push(
          intern(ctx, firstId, deps, () => ({
            kind: "tool-batch",
            key: firstId,
            members,
            collapsed,
          })),
        );
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

function appendUserItems(items: RenderItem[], ctx: BuildCtx, msg: MessageParam, mi: number): void {
  // nova-injected messages (reminders, background-notification notices, the
  // <compacted> boundary, goal-eval continuations) are read by the model but
  // never typed by the user — skip their bubbles. Identified structurally via
  // meta.synthetic, so a user who types a `<...>` tag still sees their message.
  // Compaction is instead announced via the `post_compact` info card.
  if (msg.meta?.synthetic) return;
  // Prefer the user's original typed input over the expanded model text for
  // slash commands that expand (e.g. `/agent`). Keyed by exact content.
  const display = (text: string): string => ctx.overrides?.[text] ?? text;
  const pushText = (key: string, src: object, raw: string): void => {
    const text = display(raw);
    pushWithSpacer(
      items,
      ctx,
      intern(ctx, key, [src, text], () => ({ kind: "user-text", key, text })),
    );
  };
  if (typeof msg.content === "string") {
    pushText(`u:${mi}`, msg, msg.content);
    return;
  }
  for (let bi = 0; bi < msg.content.length; bi++) {
    const b = msg.content[bi];
    if (!b || b.type !== "text") continue;
    if (b.text.trim().length === 0) continue;
    pushText(`u:${mi}:${bi}`, b, b.text);
  }
}

function appendAssistantItems(
  items: RenderItem[],
  ctx: BuildCtx,
  msg: MessageParam,
  mi: number,
): void {
  const blocks = blocksOf(msg);
  const { thinkingLabel, expandedItems } = ctx;
  // Each visible item gets a leading spacer so consecutive tools / thinking
  // / assistant-text rows are separated by a blank line. Spacer is owned by
  // the item rather than the section so the layout stays consistent
  // regardless of which item type comes first.
  const push = (item: RenderItem): void => pushWithSpacer(items, ctx, item);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as ContentBlock;
    if (block.type === "thinking") {
      // Skip empty thinking blocks (a pure tool-call turn where the model
      // produced no reasoning) — otherwise they render as a dangling
      // "✦ thinking" header with nothing under it. Mirrors the live-draft
      // guard in buildLiveDraftItems. `redacted_thinking` still renders: it
      // stands in for encrypted reasoning that genuinely exists.
      if (block.thinking.trim().length === 0) continue;
      const thKey = `th:${mi}:${i}`;
      const expanded = expandedItems[thKey] === true;
      push(
        intern(ctx, thKey, [block, thinkingLabel, expanded], () => ({
          kind: "thinking",
          key: thKey,
          thinking: block.thinking,
          // Committed thinking is "done": collapse it to a short preview. The
          // live draft (buildLiveDraftItems) stays uncollapsed so reasoning still
          // streams in full while it is being produced. The preview's "… +N lines"
          // hint is a click target (keyed by thKey) that expands the full text.
          collapsed: true,
          ...(expanded ? { expanded: true } : {}),
          ...(thinkingLabel !== undefined ? { label: thinkingLabel } : {}),
        })),
      );
    } else if (block.type === "redacted_thinking") {
      const key = `rth:${mi}:${i}`;
      push(
        intern(ctx, key, [block, thinkingLabel], () => ({
          kind: "redacted-thinking",
          key,
          ...(thinkingLabel !== undefined ? { label: thinkingLabel } : {}),
        })),
      );
    } else if (block.type === "tool_use") {
      // exitPlanMode's row is hidden like the rest, but its `plan` argument is
      // the one thing in this turn the user actually has to read — they are
      // about to approve or reject it. So render the plan itself as prose in
      // the row's place, rather than dropping the turn's whole payload.
      if (block.name === EXIT_PLAN_MODE_TOOL) {
        const plan = planToRender(block, blocks);
        if (plan === null) continue;
        const key = `plan:${mi}:${i}`;
        push(
          intern(ctx, key, [block], () => ({ kind: "assistant-text", key, text: plan })),
        );
        continue;
      }
      if (HIDDEN_TOOLS.has(block.name)) continue;

      const details = ctx.toolDetails?.[block.id];
      const tcKey = `tc:${mi}:${i}`;
      const result = ctx.resultIndex.get(block.id);
      const expanded = expandedItems[tcKey] === true;
      // Read the pre-write file once, here, so the diff can never be recomputed
      // against the post-write content (see writeBaseline).
      const baseline = block.name === "write" ? writeBaseline(block) : undefined;
      push(
        intern(ctx, tcKey, [block, result, details, expanded], () => ({
          kind: "tool-call",
          key: tcKey,
          use: block,
          result,
          ...(details && details.length > 0 ? { details } : {}),
          // A done body-bearing call (write/edit/bash) collapses to a preview; if
          // the user clicked its hint, `expandedItems` carries the key and we show
          // the full body. Mirrors the committed-thinking expand path above.
          ...(expanded ? { expanded: true } : {}),
          ...(baseline !== undefined ? { baseline } : {}),
        })),
      );
    } else if (block.type === "text") {
      // Render text at its real position in the block stream so "narrate then
      // act" turns (text before tool_use in the same message) keep their order.
      // Skip empty text blocks — a pure tool-call turn often carries one.
      if (block.text.trim().length === 0) continue;
      const key = `at:${mi}:${i}`;
      push(
        intern(ctx, key, [block], () => ({
          kind: "assistant-text",
          key,
          text: block.text,
        })),
      );
    }
  }
}
