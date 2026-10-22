import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { messageParamSchema, migrateLegacyMeta, type MessageParam } from "@nova/core";

// Version the disk record, not the canonical message or the model request.
// In this format an absent meta means exactly that; only unversioned legacy
// records need the old tag-based inference. Per-record versions also allow
// appending safely to an old session without rewriting its retained prefix.
const MESSAGE_FORMAT_VERSION = 1;
const persistedMessageSchema = messageParamSchema.extend({
  formatVersion: z.literal(MESSAGE_FORMAT_VERSION).optional(),
});

export interface PersistCursor {
  count: number;
  /** Canonical JSON of the last message, excluding the disk format version. */
  lastLine: string | null;
}

export const emptyCursor: PersistCursor = { count: 0, lastLine: null };

function encode(msgs: MessageParam[]): string {
  if (msgs.length === 0) return "";
  return (
    msgs.map((m) => JSON.stringify({ ...m, formatVersion: MESSAGE_FORMAT_VERSION })).join("\n") +
    "\n"
  );
}

function cursorOf(msgs: MessageParam[]): PersistCursor {
  if (msgs.length === 0) return { count: 0, lastLine: null };
  return { count: msgs.length, lastLine: JSON.stringify(msgs[msgs.length - 1]) };
}

async function rewriteAll(path: string, msgs: MessageParam[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, encode(msgs), "utf8");
  await rename(tmp, path);
}

async function appendChunk(path: string, msgs: MessageParam[]): Promise<void> {
  if (msgs.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, encode(msgs), "utf8");
}

/**
 * Persist `messages` to `path` as JSONL. Decides append vs. atomic rewrite by
 * comparing against `cursor`: if the on-disk prefix is still intact, only the
 * delta is appended; otherwise (clear / rewind / divergence) the file is
 * rewritten atomically. Returns the new cursor.
 */
export async function persistMessages(
  path: string,
  messages: MessageParam[],
  cursor: PersistCursor,
): Promise<PersistCursor> {
  // No-op when nothing changed.
  if (messages.length === cursor.count) {
    if (cursor.count === 0) return cursor;
    const tail = JSON.stringify(messages[messages.length - 1]);
    if (tail === cursor.lastLine) return cursor;
  }

  // Fast path: append-only if the on-disk prefix is unchanged. An empty cursor
  // does NOT qualify — it means "this writer has not written yet", which says
  // nothing about what is already on disk. Appending on that assumption would
  // concatenate onto a pre-existing file (a scratch path reused across runs is
  // the realistic case); rewriting is both correct and cheap at that point.
  if (messages.length > cursor.count && cursor.count > 0) {
    const prefixIntact = JSON.stringify(messages[cursor.count - 1]) === cursor.lastLine;
    if (prefixIntact) {
      await appendChunk(path, messages.slice(cursor.count));
      return cursorOf(messages);
    }
  }

  // Diverged or shrunk: rewrite the whole file atomically.
  await rewriteAll(path, messages);
  return cursorOf(messages);
}

export interface LoadMessagesOptions {
  /**
   * Called once per unreadable line, with the 1-based line number. Lines are
   * skipped rather than aborting the load: history is appended a line at a
   * time, so a kill mid-write leaves a torn final line, and refusing to open
   * the session over it would throw away everything before it. Callers should
   * surface a single warning when this fires.
   */
  onSkip?: (info: { line: number; error: string }) => void;
}

export async function loadMessages(
  path: string,
  opts: LoadMessagesOptions = {},
): Promise<MessageParam[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const messages: MessageParam[] = [];
  const lines = raw.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.length === 0) continue;
    try {
      const { formatVersion, ...message } = persistedMessageSchema.parse(JSON.parse(line));
      messages.push(formatVersion === undefined ? migrateLegacyMeta(message) : message);
    } catch (err) {
      opts.onSkip?.({
        line: i + 1,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return messages;
}
