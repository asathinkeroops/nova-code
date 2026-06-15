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

/**
 * Sum every persisted `post_request` usage in a session's transcript so the
 * cache-hit-rate meter and `/usage` survive a restart / `/resume`. The
 * transcript is the single source of truth — one record per model request,
 * appended across every run of the session — so replaying it needs no extra
 * on-disk state and can't drift from the live counters.
 *
 * Returns all-zero when the transcript is absent or empty (e.g. a fresh
 * session, or one started with `noTranscript`). Malformed lines are skipped by
 * `Transcript.readAll`; legacy pre-rename request records are not counted.
 */
export async function restoreUsageFromTranscript(transcriptPath: string): Promise<UsageTotals> {
  const totals: UsageTotals = {
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
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
  return totals;
}
