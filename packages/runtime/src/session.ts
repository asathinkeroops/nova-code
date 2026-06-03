import { mkdir, readdir, rm, stat } from "node:fs/promises";
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

export interface ExpiringSession {
  id: string;
  dir: string;
  lastActiveAt: Date;
}

/**
 * Pure retention policy: pick the sessions whose last activity predates the
 * `maxAgeDays` cutoff relative to `now`, skipping any id in `protectedIds`.
 * Side-effect-free so it can be unit-tested without touching the filesystem.
 * A non-positive or non-finite `maxAgeDays` disables pruning (returns nothing).
 */
export function selectExpiredSessions(
  sessions: ExpiringSession[],
  now: Date,
  maxAgeDays: number,
  protectedIds: Iterable<string> = [],
): ExpiringSession[] {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return [];
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const keep = new Set(protectedIds);
  return sessions.filter((s) => !keep.has(s.id) && s.lastActiveAt.getTime() < cutoff);
}

// Last-activity time for a session: the newest mtime among its history and
// transcript files (those get appended every turn), falling back to the
// directory creation time when neither file exists yet — a freshly created,
// never-written session.
async function lastActivityAt(s: Session): Promise<Date> {
  let latest = 0;
  for (const p of [s.messagesPath, s.transcriptPath]) {
    const st = await stat(p).catch(() => null);
    if (st) latest = Math.max(latest, st.mtimeMs);
  }
  return latest > 0 ? new Date(latest) : s.createdAt;
}

export interface PruneSessionsOptions {
  rootOverride?: string;
  maxAgeDays: number;
  now?: Date;
  /** Session ids that must never be deleted (e.g. the active/resumed session). */
  protectedIds?: string[];
}

export interface PruneSessionsResult {
  removed: string[];
  failed: number;
}

/**
 * Delete session directories whose last activity is older than `maxAgeDays`.
 * Meant to run once at startup; pass the active session id in `protectedIds` so
 * a `--resume`/`--continue` of an old session is never deleted out from under
 * the user. Best-effort: a directory that fails to delete is counted in
 * `failed` and does not abort the sweep.
 */
export async function pruneSessions(opts: PruneSessionsOptions): Promise<PruneSessionsResult> {
  const sessions = await listSessions(opts.rootOverride);
  const aged: ExpiringSession[] = [];
  for (const s of sessions) {
    aged.push({ id: s.id, dir: s.dir, lastActiveAt: await lastActivityAt(s) });
  }
  const expired = selectExpiredSessions(
    aged,
    opts.now ?? new Date(),
    opts.maxAgeDays,
    opts.protectedIds ?? [],
  );
  const removed: string[] = [];
  let failed = 0;
  for (const s of expired) {
    try {
      await rm(s.dir, { recursive: true, force: true });
      removed.push(s.id);
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
