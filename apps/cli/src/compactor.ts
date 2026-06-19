import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { autoCompact, microCompact, shouldAutoCompact } from "@nova/context";
import type { MessageParam, ModelClient } from "@nova/core";
import { resolveContextWindowSize, type Settings } from "@nova/runtime";

export interface BuildCompactorOptions {
  settings: Settings;
  /** Closes over the CLI's live model binding. */
  getModel: () => ModelClient;
  /** Closes over the CLI's mutable session binding so /resume swaps land in the new session dir. */
  getSessionDir: () => string;
  /**
   * Fired right before auto-compact runs the summarizer (awaited). Return
   * `{ block: true }` to skip this compaction (a PreCompact hook vetoed it).
   */
  onPreCompact?: (info: {
    before: number;
  }) => { block: boolean } | void | Promise<{ block: boolean } | void>;
  /** Fired when auto-compact actually replaces the history (not on micro-only passes). Awaited. */
  onAutoCompact?: (info: {
    before: number;
    after: number;
    transcriptPath?: string;
  }) => void | Promise<void>;
}

async function saveSnapshot(sessionDir: string, messages: MessageParam[]): Promise<string> {
  const snapDir = join(sessionDir, "snapshots");
  await mkdir(snapDir, { recursive: true });
  const file = join(snapDir, `${Date.now()}.jsonl`);
  const body = messages.map((m) => JSON.stringify(m)).join("\n");
  await writeFile(file, body, "utf8");
  return file;
}

export interface ManualCompactOptions {
  settings: Settings;
  getModel: () => ModelClient;
  getSessionDir: () => string;
  focus?: string;
}

export interface ManualCompactResult {
  messages: MessageParam[];
  before: number;
  after: number;
  transcriptPath?: string;
}

/**
 * Unconditional compaction entry point for the `/compact` slash command —
 * bypasses `shouldAutoCompact` and always runs the summarizer.
 */
export async function manualCompact(
  messages: MessageParam[],
  opts: ManualCompactOptions,
): Promise<ManualCompactResult> {
  const auto = opts.settings.compact.auto;
  const before = messages.length;
  const result = await autoCompact(messages, {
    model: opts.getModel(),
    ...(opts.focus ? { focus: opts.focus } : {}),
    ...(auto.maxSummaryTokens !== undefined ? { maxSummaryTokens: auto.maxSummaryTokens } : {}),
    saveTranscript: (msgs) => saveSnapshot(opts.getSessionDir(), msgs),
  });
  return {
    messages: result.messages,
    before,
    after: result.messages.length,
    ...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
  };
}

export function buildCompactor(
  opts: BuildCompactorOptions,
): (messages: MessageParam[]) => Promise<MessageParam[]> {
  const { settings, getModel, getSessionDir, onPreCompact, onAutoCompact } = opts;
  const micro = settings.compact.micro;
  const auto = settings.compact.auto;

  return async (messages) => {
    let next = messages;

    if (micro.enabled) {
      const r = microCompact(next, {
        ...(micro.keepRecent !== undefined ? { keepRecent: micro.keepRecent } : {}),
        ...(micro.minContentChars !== undefined ? { minContentChars: micro.minContentChars } : {}),
        ...(micro.preserveTools !== undefined ? { preserveTools: micro.preserveTools } : {}),
      });
      next = r.messages;
    }

    if (!auto.enabled) return next;

    const trigger = shouldAutoCompact(next, {
      // Read live: follows the active model tier's window after a /model switch.
      contextWindowSize: resolveContextWindowSize(settings, settings.model),
      ...(auto.thresholdTokens !== undefined ? { thresholdTokens: auto.thresholdTokens } : {}),
      ...(auto.contextWindowPercent !== undefined
        ? { contextWindowPercent: auto.contextWindowPercent }
        : {}),
    });
    if (!trigger) return next;

    const before = next.length;
    const pre = await onPreCompact?.({ before });
    if (pre?.block) return next;
    const result = await autoCompact(next, {
      model: getModel(),
      ...(auto.maxSummaryTokens !== undefined ? { maxSummaryTokens: auto.maxSummaryTokens } : {}),
      saveTranscript: (msgs) => saveSnapshot(getSessionDir(), msgs),
    });
    await onAutoCompact?.({
      before,
      after: result.messages.length,
      ...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
    });
    return result.messages;
  };
}
