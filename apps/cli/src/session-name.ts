import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * User-assigned display names for sessions, set via `/rename`. Persisted to a
 * single global `~/.nova/session-names.json` keyed by session id (rather than a
 * per-session file) so all names live in one place; shown as a badge on the
 * InputBox's top frame and nowhere else.
 */

/**
 * Cap on a session name, in "units": each CJK character is one unit, each
 * whitespace-delimited word is one unit, and each interior space is one unit
 * too. So the limit is ~30 CJK characters or ~30 English words, with the spaces
 * between words also counting. Keeps the name short enough to stay legible on
 * the InputBox frame.
 */
export const MAX_SESSION_NAME_UNITS = 30;

// CJK ideographs + Japanese kana + Hangul syllables — characters counted one-each.
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/** Location of the shared name store: `~/.nova/session-names.json`. */
function storePath(): string {
  return join(homedir(), ".nova", "session-names.json");
}

/**
 * Collapse interior whitespace runs to single spaces, trim the ends, then clamp
 * to {@link MAX_SESSION_NAME_UNITS} units — counting each CJK character, each
 * word, and each interior space as one. Word continuation characters belong to
 * the word's unit, so a long single word is kept whole. A trailing space left by
 * the cut is trimmed off.
 */
export function normalizeSessionName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  let units = 0;
  let inWord = false;
  const kept: string[] = [];
  for (const ch of collapsed) {
    if (ch === " ") {
      if (units >= MAX_SESSION_NAME_UNITS) break;
      units += 1; // a space is its own unit
      inWord = false;
    } else if (CJK_RE.test(ch)) {
      if (units >= MAX_SESSION_NAME_UNITS) break;
      units += 1;
      inWord = false;
    } else if (!inWord) {
      // First character of a new word starts a fresh word unit.
      if (units >= MAX_SESSION_NAME_UNITS) break;
      units += 1;
      inWord = true;
    }
    // A word's continuation characters add no unit — they join the current word.
    kept.push(ch);
  }
  return kept.join("").trim();
}

/** Read the whole id→name map. Returns {} when absent / malformed. Never throws. */
async function readStore(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === "string") out[id] = name;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the whole map atomically (write-temp + rename). */
async function writeStore(store: Record<string, string>): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await rename(tmp, path);
}

/** Read the name for `sessionId`, or null when unset / empty. Never throws. */
export async function loadSessionName(sessionId: string): Promise<string | null> {
  const store = await readStore();
  const raw = store[sessionId];
  if (typeof raw !== "string") return null;
  const name = normalizeSessionName(raw);
  return name.length > 0 ? name : null;
}

/** Set the name for `sessionId`, leaving every other entry untouched. */
export async function saveSessionName(sessionId: string, name: string): Promise<void> {
  const store = await readStore();
  store[sessionId] = name;
  await writeStore(store);
}

/** Remove the name for `sessionId`. No-op when it is already absent. */
export async function clearSessionName(sessionId: string): Promise<void> {
  const store = await readStore();
  if (!(sessionId in store)) return;
  delete store[sessionId];
  await writeStore(store);
}
