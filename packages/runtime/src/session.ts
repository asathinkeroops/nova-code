import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface Session {
  id: string;
  dir: string;
  createdAt: Date;
  transcriptPath: string;
  messagesPath: string;
}

function defaultRoot(): string {
  return join(homedir(), ".nova", "sessions");
}

function makeId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `${iso}-${randomUUID().slice(0, 8)}`;
}

export async function createSession(rootOverride?: string): Promise<Session> {
  const root = rootOverride ? resolve(rootOverride) : defaultRoot();
  const createdAt = new Date();
  const id = makeId(createdAt);
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  return {
    id,
    dir,
    createdAt,
    transcriptPath: join(dir, "transcript.jsonl"),
    messagesPath: join(dir, "messages.jsonl"),
  };
}

export async function listSessions(rootOverride?: string): Promise<Session[]> {
  const root = rootOverride ? resolve(rootOverride) : defaultRoot();
  try {
    const entries = await readdir(root);
    const sessions: Session[] = [];
    for (const id of entries) {
      const dir = join(root, id);
      const s = await stat(dir).catch(() => null);
      if (!s?.isDirectory()) continue;
      sessions.push({
        id,
        dir,
        createdAt: s.birthtime,
        transcriptPath: join(dir, "transcript.jsonl"),
        messagesPath: join(dir, "messages.jsonl"),
      });
    }
    return sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  } catch {
    return [];
  }
}

export async function getSession(id: string, rootOverride?: string): Promise<Session | null> {
  const root = rootOverride ? resolve(rootOverride) : defaultRoot();
  const dir = join(root, id);
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) return null;
  return {
    id,
    dir,
    createdAt: s.birthtime,
    transcriptPath: join(dir, "transcript.jsonl"),
    messagesPath: join(dir, "messages.jsonl"),
  };
}
