import { appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Per-session sidecar that records, for slash commands that EXPAND into a
 * longer model prompt (e.g. `/agent`, `/plan`, `/init`), the user's original
 * typed input. The canonical `messages.jsonl` only stores the expanded text
 * (the model's truth); the renderer consults this map to show what the user
 * actually typed instead.
 *
 * Keyed by the expanded model text — the exact string content of the resulting
 * user message. The expansion templates are injective (the raw command is
 * recoverable from the expansion), so distinct inputs never collide on a key;
 * re-running the same command maps to the same display, which is correct.
 *
 * Stored as JSONL (one record per line, append-only) so recording a new
 * override never rewrites the file; on load, later records win on key
 * collision. Lives next to `messages.jsonl` so it survives `/resume` and `-c`.
 */

const FILENAME = "display-overrides.jsonl";

/** A single sidecar record: `expanded` is the user message's string content. */
interface OverrideRecord {
  expanded: string;
  raw: string;
}

function asRecord(value: unknown): OverrideRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { expanded, raw } = value as Record<string, unknown>;
  if (typeof expanded !== "string" || typeof raw !== "string") return null;
  return { expanded, raw };
}

export function displayOverridesPath(sessionDir: string): string {
  return join(sessionDir, FILENAME);
}

/**
 * Read the sidecar and fold it into an `{ [expanded]: raw }` map. Missing file
 * → empty map. Malformed lines are skipped rather than fatal — a corrupt
 * display hint must never block resuming a session.
 */
export async function loadDisplayOverrides(
  sessionDir: string,
): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(displayOverridesPath(sessionDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const map: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (rec) map[rec.expanded] = rec.raw;
  }
  return map;
}

/** Append one override record. */
export async function appendDisplayOverride(
  sessionDir: string,
  expanded: string,
  rawInput: string,
): Promise<void> {
  const line = JSON.stringify({ expanded, raw: rawInput }) + "\n";
  await appendFile(displayOverridesPath(sessionDir), line, "utf8");
}

/** Remove the sidecar entirely (used by `/clear`). ENOENT is a no-op. */
export async function clearDisplayOverrides(sessionDir: string): Promise<void> {
  await rm(displayOverridesPath(sessionDir), { force: true });
}
