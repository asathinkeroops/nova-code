import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persistent ↑/↓ recall history for the permanent InputBox, stored in its own
 * file under `~/.nova` rather than derived from the live message stream. This
 * survives across sessions and is independent of `/clear`, so the user can
 * recall recent prompts even in a fresh conversation. Kept deliberately small
 * (the most recent {@link INPUT_HISTORY_LIMIT} entries) — it's a quick-recall
 * buffer, not a searchable log.
 */

/** Max entries kept on disk; older submissions are dropped past this. */
export const INPUT_HISTORY_LIMIT = 50;

/** `~/.nova/input-history.json` — the on-disk recall buffer. */
export function inputHistoryPath(): string {
  return join(homedir(), ".nova", "input-history.json");
}

/**
 * Append `line` to `history` as the newest entry, returning a new array. The
 * line is trimmed-checked (empty/whitespace-only is ignored, returning the
 * input unchanged) and de-duplicated MRU-style: any prior identical entry is
 * removed so it moves to the end rather than accumulating. The result is capped
 * to the newest {@link INPUT_HISTORY_LIMIT} entries, oldest first.
 */
export function appendInputHistory(history: string[], line: string): string[] {
  if (line.trim().length === 0) return history;
  const next = history.filter((h) => h !== line);
  next.push(line);
  return next.slice(-INPUT_HISTORY_LIMIT);
}

/**
 * Read the persisted history (oldest first), capped to the newest
 * {@link INPUT_HISTORY_LIMIT} entries. A missing or malformed file yields an
 * empty list rather than throwing — recall is a convenience, never load-bearing.
 */
export async function loadInputHistory(path: string = inputHistoryPath()): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string").slice(-INPUT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Persist `history` atomically (write-temp-then-rename so a crash mid-write
 * never leaves a truncated file). Best-effort: write failures are swallowed
 * since losing recall history is harmless.
 */
export async function saveInputHistory(
  history: string[],
  path: string = inputHistoryPath(),
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(history.slice(-INPUT_HISTORY_LIMIT))}\n`, "utf8");
    await rename(tmp, path);
  } catch {
    // ignore — recall history is non-critical
  }
}
