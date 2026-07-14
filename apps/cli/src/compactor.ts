import { autoCompact, shouldAutoCompact, sliceFromLastCompacted } from "@nova/context";
import { resolveProfile, type MessageParam, type ModelClient } from "@nova/core";
import { resolveContextWindowSize, type Settings } from "@nova/runtime";

export interface BuildCompactorOptions {
  settings: Settings;
  /** Closes over the CLI's live model binding. */
  getModel: () => ModelClient;
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
  settings: Settings;
  getModel: () => ModelClient;
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
  const auto = opts.settings.compact.auto;
  const view = sliceFromLastCompacted(messages);
  const result = await autoCompact(view, {
    model: opts.getModel(),
    ...(opts.focus ? { focus: opts.focus } : {}),
    ...(auto.maxSummaryTokens !== undefined ? { maxSummaryTokens: auto.maxSummaryTokens } : {}),
  });
  return {
    messages: [...messages, ...result.messages],
    before: view.length,
    after: result.messages.length,
  };
}

export function buildCompactor(
  opts: BuildCompactorOptions,
): (messages: MessageParam[]) => Promise<MessageParam[]> {
  const { settings, getModel, onPreCompact, onAutoCompact } = opts;
  const auto = settings.compact.auto;

  return async (messages) => {
    // Returning the SAME reference signals "no compaction" to the pre_compact
    // hook (see packages/agent/src/agent.ts), so every no-op path below must
    // return `messages` unchanged.
    if (!auto.enabled) return messages;

    // Auto-compaction triggers on the MODEL VIEW (the post-boundary slice that
    // is actually sent), not the full retained history — otherwise the ever-
    // growing archive would re-trigger on every turn.
    const view = sliceFromLastCompacted(messages);
    const trigger = shouldAutoCompact(
      view,
      {
        // Read live: follows the active model tier's window after a /model switch.
        contextWindowSize: resolveContextWindowSize(settings, settings.model),
        ...(auto.thresholdTokens !== undefined ? { thresholdTokens: auto.thresholdTokens } : {}),
        ...(auto.contextWindowPercent !== undefined
          ? { contextWindowPercent: auto.contextWindowPercent }
          : {}),
      },
      resolveProfile(settings.provider).tokenEstimate,
    );
    if (!trigger) return messages;

    const before = view.length;
    const pre = await onPreCompact?.({ before });
    if (pre?.block) return messages;
    const result = await autoCompact(view, {
      model: getModel(),
      ...(auto.maxSummaryTokens !== undefined ? { maxSummaryTokens: auto.maxSummaryTokens } : {}),
    });
    // Append the boundary to the full history — never replace it.
    const next = [...messages, ...result.messages];
    await onAutoCompact?.({ before, after: result.messages.length });
    return next;
  };
}
