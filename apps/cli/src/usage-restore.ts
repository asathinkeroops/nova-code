import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Transcript } from "@nova/observability";

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

/** Fold every `post_request` usage in one transcript file into `totals`. */
async function accumulateTranscript(transcriptPath: string, totals: UsageTotals): Promise<void> {
  const records = await new Transcript(transcriptPath).readAll();
  for (const rec of records) {
    if (rec.kind !== "post_request") continue;
    const usage = (rec.data as { usage?: RecordedUsage } | undefined)?.usage;
    if (!usage) continue;
    totals.uncachedInputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
    totals.cacheCreationTokens += usage.cacheCreationInputTokens ?? 0;
  }
}

/**
 * Sum every persisted `post_request` usage in a session's transcript — plus the
 * per-sub-agent transcripts under `subagentsDir`, when given — so the
 * cache-hit-rate meter and `/usage` survive a restart / `/resume`. The
 * transcripts are the single source of truth — one record per model request,
 * appended across every run — so replaying them needs no extra on-disk state and
 * can't drift from the live counters. Sub-agent spend is folded into the same
 * totals (no main/child split), matching how the live `onUsage` sink merges it.
 *
 * Returns all-zero when the transcript is absent or empty (e.g. a fresh
 * session, or one started with `noTranscript`). Malformed lines are skipped by
 * `Transcript.readAll`; a missing `subagentsDir` (no sub-agent ever ran) is
 * ignored; legacy pre-rename request records are not counted.
 */
export async function restoreUsageFromTranscript(
  transcriptPath: string,
  subagentsDir?: string,
): Promise<UsageTotals> {
  const totals: UsageTotals = {
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
  await accumulateTranscript(transcriptPath, totals);

  if (subagentsDir) {
    // Each sub-agent writes `<id>.transcript.jsonl` here; sum them all. The dir
    // is absent until the first sub-agent runs, so swallow a read error.
    const entries = await readdir(subagentsDir).catch(() => [] as string[]);
    for (const name of entries) {
      if (!name.endsWith(".transcript.jsonl")) continue;
      await accumulateTranscript(join(subagentsDir, name), totals);
    }
  }
  return totals;
}

/**
 * Total tokens of the *most recent* model request in a session's transcript —
 * input + cache read + cache creation + output — matching the live `post_request`
 * hook's `setContextTokens` snapshot. Unlike `restoreUsageFromTranscript` (which
 * sums every request for the cumulative `/usage` row), this is the last request's
 * total alone, a proxy for how full the context window currently is, so the
 * statusline's context meter is correct immediately after a restart / `/resume`
 * rather than reading 0% until the next model turn.
 *
 * Only the main transcript is consulted — sub-agent spend never occupies the main
 * session's context window. Returns 0 when the transcript is absent, empty, or has
 * no `post_request` record yet (e.g. a fresh session).
 */
export async function restoreContextTokensFromTranscript(transcriptPath: string): Promise<number> {
  const records = await new Transcript(transcriptPath).readAll();
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec?.kind !== "post_request") continue;
    const usage = (rec.data as { usage?: RecordedUsage } | undefined)?.usage;
    if (!usage) continue;
    return (
      (usage.inputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0) +
      (usage.outputTokens ?? 0)
    );
  }
  return 0;
}
