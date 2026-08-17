import { autoCompact, shouldAutoCompact, sliceFromLastCompacted } from "@nova/agent";
import {
  type Compactor,
  type MessageParam,
  type ModelClient,
} from "@nova/core";
import {
  resolveProfile,
} from "@nova/model";
import { resolveContextWindowSize, type Settings } from "@nova/base";

export interface BuildCompactorOptions {
  settings: Settings;
  /** Closes over the CLI's live model binding. */
  getModel: () => ModelClient;
  /**
   * Tokens the next request will spend on the system prompt and tool schemas.
   * Counted against the compaction threshold alongside the messages, so the
   * trigger measures the same thing `/context` displays.
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
 * Unconditional compaction entry point for the `/compact` slash command —
 * bypasses `shouldAutoCompact` and always runs the summarizer.
 *
 * The summarizer sees only the current model view (`sliceFromLastCompacted`);
 * its `<compacted>` boundary is APPENDED to the full append-only history, which
 * is never truncated (the TUI keeps rendering it; only the model reads the
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
  const { settings, getModel, getOverheadTokens, onPreCompact, onAutoCompact } = opts;
  const auto = settings.compact.auto;

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
          contextWindowSize: resolveContextWindowSize(settings, settings.model),
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
        resolveProfile(settings.provider).tokenEstimate,
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
