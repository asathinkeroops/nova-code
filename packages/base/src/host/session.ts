import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const sessionMetadataSchema = z
  .object({
    version: z.literal(1),
    workspace: z.string().min(1),
    /**
     * Set when the workspace above is a LINKED git worktree: the main checkout
     * it belongs to. Recorded so a resume can tell "this worktree was deleted"
     * (fall back to the launch directory, clearing the binding) apart from
     * "this session belongs to an unrelated directory" (refuse).
     */
    worktree: z
      .object({ main: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export interface Session {
  id: string;
  dir: string;
  createdAt: Date;
  metadataPath: string;
  transcriptPath: string;
  messagesPath: string;
}

export interface CreateSessionOptions {
  workspace: string;
  /** Main checkout, when `workspace` is a linked worktree of one. */
  worktreeMain?: string;
  rootOverride?: string;
}

function defaultRoot(): string {
  return join(homedir(), ".nova", "sessions");
}

function makeId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `${iso}-${randomUUID().slice(0, 8)}`;
}

export async function createSession(opts: CreateSessionOptions): Promise<Session> {
  const root = opts.rootOverride ? resolve(opts.rootOverride) : defaultRoot();
  const createdAt = new Date();
  const id = makeId(createdAt);
  const dir = join(root, id);
  const metadataPath = join(dir, "session.json");
  const input = sessionMetadataSchema.parse({
    version: 1,
    workspace: opts.workspace,
    ...(opts.worktreeMain ? { worktree: { main: opts.worktreeMain } } : {}),
  });
  const metadata: SessionMetadata = {
    ...input,
    workspace: resolve(input.workspace),
    ...(input.worktree ? { worktree: { main: resolve(input.worktree.main) } } : {}),
  };
  await mkdir(dir, { recursive: true });
  // The workspace is creation-time identity, not mutable session activity.
  // `wx` makes accidental rebinding fail even if this code is later reused
  // against an existing directory.
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
  return {
    id,
    dir,
    createdAt,
    metadataPath,
    transcriptPath: join(dir, "transcript.jsonl"),
    messagesPath: join(dir, "messages.jsonl"),
  };
}

/** Read the immutable workspace recorded when a session was created. */
export async function readSessionWorkspace(session: Session): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(session.metadataPath, "utf8"));
    const result = sessionMetadataSchema.safeParse(parsed);
    return result.success ? result.data.workspace : undefined;
  } catch {
    // Legacy sessions have no session.json. Their transcript fallback lives in
    // the CLI, which owns the session_start event shape.
    return undefined;
  }
}

/**
 * Re-bind a session to a different workspace, in place.
 *
 * The binding is "immutable at creation" by default — that is what makes
 * `--continue`/`--resume` safe (a session can't be silently adopted by an
 * unrelated directory). A git-worktree switch is the one deliberate exception:
 * the session moves with its workspace, so the recorded path has to move too,
 * or the next resume would refuse to re-enter. Written via a temp file +
 * rename so a crash mid-write can't leave unparseable metadata behind (an
 * unreadable `session.json` reads as "no binding", which would make the session
 * resumable from anywhere).
 */
export async function writeSessionWorkspace(
  session: Session,
  workspace: string,
  worktreeMain?: string,
): Promise<void> {
  const metadata: SessionMetadata = {
    version: 1,
    workspace: resolve(workspace),
    ...(worktreeMain ? { worktree: { main: resolve(worktreeMain) } } : {}),
  };
  const tmp = `${session.metadataPath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(metadata)}\n`, "utf8");
  await rename(tmp, session.metadataPath);
}

/** The main checkout, when the session's workspace is a linked worktree. */
export async function readSessionWorktreeMain(session: Session): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(session.metadataPath, "utf8"));
    const result = sessionMetadataSchema.safeParse(parsed);
    return result.success ? result.data.worktree?.main : undefined;
  } catch {
    return undefined;
  }
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
        metadataPath: join(dir, "session.json"),
        transcriptPath: join(dir, "transcript.jsonl"),
        messagesPath: join(dir, "messages.jsonl"),
      });
    }
    // Sort by persisted conversation activity, not transcript activity. Merely
    // starting or continuing a session appends `session_start` to the transcript;
    // allowing that mtime to drive the order can pin `--continue` to an empty or
    // stale session. `messages.jsonl` changes only when resumable history changes.
    const messageActivity = new Map<string, number>();
    await Promise.all(
      sessions.map(async (s) => {
        const messages = await stat(s.messagesPath).catch(() => null);
        messageActivity.set(s.id, messages?.mtimeMs ?? 0);
      }),
    );
    return sessions.sort(
      (a, b) => (messageActivity.get(b.id) ?? 0) - (messageActivity.get(a.id) ?? 0),
    );
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
    metadataPath: join(dir, "session.json"),
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

// Retention activity for a session: the newest mtime among its history and
// transcript files, falling back to directory creation time when neither file
// exists yet. This intentionally includes transcript-only activity for cleanup;
// `listSessions` ordering intentionally does not (see above).
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
