/**
 * The compaction PORT — the policy wrapper `@nova/core`'s loop consults.
 *
 * `compact.ts` owns the mechanics (the boundary, the model-facing slice, the
 * threshold math, the summarizer call); this file owns the decisions built on
 * top of them: whether auto-compaction is enabled, what the threshold is
 * measured against, who may veto a pass, and who hears about one that ran.
 *
 * Everything that can change mid-session arrives as a getter — the port object
 * is built once (see the liveness rule in `@nova/core`'s `ports.ts`), so a
 * `/model` switch has to be visible through a method call, not a captured field.
 */

import type { Compactor, MessageParam, ModelClient } from "@nova/core";
import type { TokenEstimate } from "@nova/base";
import { autoCompact, shouldAutoCompact, sliceFromLastCompacted } from "./compact.js";

/**
 * Auto-compaction policy — the `compact.auto` slice of the settings schema,
 * copied as plain values so the agent stays uncoupled from it (same reasoning as
 * `AgentSettingsSlice`). Read once at build time: no runtime path changes these
 * today; make it a getter if one appears.
 */
export interface AutoCompactPolicy {
  /** Whether the automatic path may run at all. `/compact` ignores this. */
  enabled: boolean;
  /** Hard token ceiling. Wins over the percentage when set. */
  thresholdTokens?: number;
  /** Share of the context window that triggers compaction. */
  contextWindowPercent?: number;
  /** Cap on the summarizer's response. */
  maxSummaryTokens?: number;
}

export interface BuildCompactorOptions {
  auto: AutoCompactPolicy;
  /** The summarizer's model. A getter: it follows the host's live binding. */
  getModel: () => ModelClient;
  /**
   * The active model tier's context window, which the percentage threshold is
   * taken from. A getter because `/model` switches tiers mid-session.
   */
  getContextWindowSize: () => number;
  /**
   * The provider's tokenizer ratios, so a CJK-heavy conversation isn't
   * under-counted (which would trip the trigger too late). A getter for the
   * same reason as the window size. Omit for the default ratios.
   */
  getTokenEstimate?: () => TokenEstimate;
  /**
   * Tokens the next request will spend on the system prompt and tool schemas
   * (see `measureFixedOverhead`). Counted against the threshold alongside the
   * messages, so the trigger measures the same thing a context panel displays.
   *
   * A getter, not a value: MCP servers connect after startup and plan mode
   * swaps the tool registry, so the overhead changes within a session.
   */
  getOverheadTokens?: () => number;
  /**
   * Fired right before auto-compact runs the summarizer (awaited). Return
   * `{ block: true }` to skip this compaction (a PreCompact hook vetoed it).
   */
  onPreCompact?: (info: {
    before: number;
  }) => { block: boolean } | void | Promise<{ block: boolean } | void>;
  /** Fired when auto-compact actually appends a boundary (not on no-op passes). Awaited. */
  onAutoCompact?: (info: { before: number; after: number }) => void | Promise<void>;
}

export interface ManualCompactOptions {
  /** The session's compaction port — the same one the loop consults. */
  compactor: Compactor;
  focus?: string;
}

export interface ManualCompactResult {
  messages: MessageParam[];
  before: number;
  after: number;
}

/**
 * Unconditional compaction entry point for a `/compact`-style command —
 * bypasses `shouldAutoCompact` and always runs the summarizer.
 *
 * The summarizer sees only the current model view (`sliceFromLastCompacted`);
 * its `<compacted>` boundary is APPENDED to the full append-only history, which
 * is never truncated (a TUI keeps rendering it; only the model reads the
 * post-boundary slice). `before`/`after` report the model-view compression.
 */
export async function manualCompact(
  messages: MessageParam[],
  opts: ManualCompactOptions,
): Promise<ManualCompactResult> {
  const before = opts.compactor.view(messages).length;
  const next = await opts.compactor.compact(messages, {
    reason: "manual",
    ...(opts.focus ? { focus: opts.focus } : {}),
  });
  return {
    messages: next,
    before,
    after: opts.compactor.view(next).length,
  };
}

export function buildCompactor(opts: BuildCompactorOptions): Compactor {
  const { auto, getModel, getContextWindowSize, getTokenEstimate, getOverheadTokens } = opts;
  const { onPreCompact, onAutoCompact } = opts;

  const compact: Compactor["compact"] = async (messages, req) => {
    // Returning the SAME reference signals "no compaction" and lets the
    // pre_compact hook chain have its turn, so every no-op path below must
    // return `messages` unchanged.
    if (req.reason === "auto" && !auto.enabled) return messages;

    // Auto-compaction triggers on the MODEL VIEW (the post-boundary slice that
    // is actually sent), not the full retained history — otherwise the ever-
    // growing archive would re-trigger on every turn.
    const view = sliceFromLastCompacted(messages);
    if (req.reason === "auto") {
      const trigger = shouldAutoCompact(
        view,
        {
          // Read live: follows the active model tier's window after a /model switch.
          contextWindowSize: getContextWindowSize(),
          ...(auto.thresholdTokens !== undefined ? { thresholdTokens: auto.thresholdTokens } : {}),
          ...(auto.contextWindowPercent !== undefined
            ? { contextWindowPercent: auto.contextWindowPercent }
            : {}),
          // System prompt + tool schemas ride on every request; the threshold has
          // to see them or it fires only once the real prompt is already over.
          ...(req.overheadTokens !== undefined
            ? { overheadTokens: req.overheadTokens }
            : getOverheadTokens
              ? { overheadTokens: getOverheadTokens() }
              : {}),
        },
        getTokenEstimate?.(),
      );
      if (!trigger) return messages;
    }

    const before = view.length;
    // `/compact` is the user asking directly; only the automatic path is
    // vetoable by a PreCompact hook.
    if (req.reason === "auto") {
      const pre = await onPreCompact?.({ before });
      if (pre?.block) return messages;
    }
    const result = await autoCompact(view, {
      model: getModel(),
      ...(req.focus ? { focus: req.focus } : {}),
      ...(auto.maxSummaryTokens !== undefined ? { maxSummaryTokens: auto.maxSummaryTokens } : {}),
    });
    // Append the boundary to the full history — never replace it.
    const next = [...messages, ...result.messages];
    if (req.reason === "auto") {
      await onAutoCompact?.({ before, after: result.messages.length });
    }
    return next;
  };

  return { view: sliceFromLastCompacted, compact };
}
