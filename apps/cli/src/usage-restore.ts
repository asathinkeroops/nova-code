import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Transcript } from "@nova/runtime";

/** Session-cumulative token totals, reconstructed from a transcript. */
export interface UsageTotals {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
}

/** A `post_request` transcript record's `usage` payload (camelCase, normalized). */
interface RecordedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Fold every `post_request` usage in one transcript file into `totals`, and
 * return the last one carrying usage (error/aborted requests have none).
 */
async function accumulateTranscript(
  transcriptPath: string,
  totals: UsageTotals,
): Promise<RecordedUsage | undefined> {
  const records = await new Transcript(transcriptPath).readAll();
  let last: RecordedUsage | undefined;
  for (const rec of records) {
    if (rec.kind !== "post_request") continue;
    const usage = (rec.data as { usage?: RecordedUsage } | undefined)?.usage;
    if (!usage) continue;
    totals.uncachedInputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
    totals.cacheCreationTokens += usage.cacheCreationInputTokens ?? 0;
    last = usage;
  }
  return last;
}

/** What a restart / `/resume` rebuilds from a session's transcript. */
export interface RestoredUsage {
  /**
   * Session-cumulative totals behind `/usage` and the cache-hit-rate meter,
   * including every sub-agent's spend (no main/child split, matching how the
   * live `onUsage` sink merges it).
   */
  totals: UsageTotals;
  /**
   * Total tokens of the *most recent* main-transcript request — input + cache
   * read + cache creation + output — matching the live `post_request` hook's
   * `setContextTokens` snapshot. A proxy for how full the context window is, so
   * the statusline's meter is right immediately after a restart rather than
   * reading 0% until the next model turn. Sub-agent transcripts are excluded:
   * their spend never occupies the main session's context window.
   */
  contextTokens: number;
}

/**
 * Rebuild both counters from a session's transcript — plus the per-sub-agent
 * transcripts under `subagentsDir`, when given — in a single pass. The
 * transcripts are the single source of truth (one record per model request,
 * appended across every run), so replaying them needs no extra on-disk state and
 * can't drift from the live counters. Both counters come off the same read
 * because these files grow without bound and a long session's transcript is
 * large enough that parsing it twice on the startup path is felt.
 *
 * Returns all-zero when the transcript is absent or empty (e.g. a fresh session,
 * or one started with `noTranscript`). Malformed lines are skipped by
 * `Transcript.readAll`; a missing `subagentsDir` (no sub-agent ever ran) is
 * ignored; legacy pre-rename request records are not counted.
 */
export async function restoreFromTranscript(
  transcriptPath: string,
  subagentsDir?: string,
): Promise<RestoredUsage> {
  const totals: UsageTotals = {
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
  const last = await accumulateTranscript(transcriptPath, totals);

  if (subagentsDir) {
    // Each sub-agent writes `<id>.transcript.jsonl` here; sum them all. The dir
    // is absent until the first sub-agent runs, so swallow a read error.
    const entries = await readdir(subagentsDir).catch(() => [] as string[]);
    for (const name of entries) {
      if (!name.endsWith(".transcript.jsonl")) continue;
      await accumulateTranscript(join(subagentsDir, name), totals);
    }
  }

  const contextTokens = last
    ? (last.inputTokens ?? 0) +
      (last.cacheReadInputTokens ?? 0) +
      (last.cacheCreationInputTokens ?? 0) +
      (last.outputTokens ?? 0)
    : 0;
  return { totals, contextTokens };
}
