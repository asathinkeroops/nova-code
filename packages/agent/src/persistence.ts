import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { messageParamSchema, type MessageParam } from "@nova/core";

export interface PersistCursor {
  count: number;
  lastLine: string | null;
}

export const emptyCursor: PersistCursor = { count: 0, lastLine: null };

function encode(msgs: MessageParam[]): string {
  if (msgs.length === 0) return "";
  return msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
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
 * delta is appended; otherwise (clear / compact / divergence) the file is
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

  // Fast path: append-only if the on-disk prefix is unchanged.
  if (messages.length > cursor.count) {
    const prefixIntact =
      cursor.count === 0 ||
      JSON.stringify(messages[cursor.count - 1]) === cursor.lastLine;
    if (prefixIntact) {
      await appendChunk(path, messages.slice(cursor.count));
      return cursorOf(messages);
    }
  }

  // Diverged or shrunk: rewrite the whole file atomically.
  await rewriteAll(path, messages);
  return cursorOf(messages);
}

export async function loadMessages(path: string): Promise<MessageParam[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => messageParamSchema.parse(JSON.parse(line)));
}
