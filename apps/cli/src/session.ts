import { join } from "node:path";
import { blocksOf, extractText, type MessageParam } from "@nova/core";
import {
  createSession,
  getSession,
  listSessions,
  pruneSessions,
  type Session,
} from "@nova/runtime";
import { Transcript } from "@nova/observability";
import { dim, red } from "./colors.js";
import { refreshBanner, type CliContext } from "./context.js";
import { loadDisplaySidecar } from "./display-sidecar.js";
import { SnapshotStore } from "./snapshots.js";
import { loadMessages, emptyCursor } from "@nova/agent";

export function formatTimestamp(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function firstUserLabel(msgs: MessageParam[]): string {
  for (const m of msgs) {
    if (m.role !== "user") continue;
    const text = extractText(blocksOf(m)).replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }
  return "(no user message)";
}

export interface SessionRow {
  session: Session;
  label: string;
}

/**
 * Startup housekeeping: prune session directories older than the configured
 * retention window (settings.sessionCleanup). No-op when disabled. The active
 * session is protected so resuming an old session never deletes it mid-launch.
 * Best-effort — failures are logged, never thrown, so a cleanup hiccup can't
 * block startup.
 */
export async function pruneOldSessions(ctx: CliContext): Promise<void> {
  const { enabled, maxAgeDays } = ctx.settings.sessionCleanup;
  if (!enabled) return;
  try {
    const { removed, failed } = await pruneSessions({
      ...(ctx.settings.sessionDir ? { rootOverride: ctx.settings.sessionDir } : {}),
      maxAgeDays,
      protectedIds: [ctx.session.id],
    });
    if (removed.length > 0 || failed > 0) {
      ctx.logger.info({ removed: removed.length, failed, maxAgeDays }, "pruned expired sessions");
    }
  } catch (err) {
    ctx.logger.warn({ err }, "session cleanup failed");
  }
}

/**
 * Load every saved session and derive a one-line label from its first user
 * message. Empty sessions are skipped; sessions whose history fails to load are
 * kept with a red error label. Shared by `--list-sessions` and /resume so the
 * listing stays consistent.
 */
export async function buildSessionRows(
  sessionDir: string | undefined,
): Promise<SessionRow[]> {
  const list = await listSessions(sessionDir);
  const rows: SessionRow[] = [];
  for (const s of list) {
    try {
      const msgs = await loadMessages(s.messagesPath);
      if (msgs.length === 0) continue;
      rows.push({ session: s, label: firstUserLabel(msgs) });
    } catch (err) {
      const msg = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
      rows.push({ session: s, label: red(`load failed: ${msg.slice(0, 80)}`) });
    }
  }
  return rows;
}

export interface ResolveSessionOptions {
  resume?: string;
  continue?: boolean;
}

export async function resolveSession(
  opts: ResolveSessionOptions,
  sessionDir: string | undefined,
): Promise<{ session: Session; resumed: boolean }> {
  if (opts.resume) {
    const found = await getSession(opts.resume, sessionDir);
    if (!found) {
      throw new Error(`session ${opts.resume} not found`);
    }
    return { session: found, resumed: true };
  }
  if (opts.continue) {
    const list = await listSessions(sessionDir);
    if (list.length === 0) {
      throw new Error("no sessions to continue");
    }
    return { session: list[0]!, resumed: true };
  }
  return { session: await createSession(sessionDir), resumed: false };
}

export async function printSessionList(sessionDir: string | undefined): Promise<void> {
  const rows = await buildSessionRows(sessionDir);
  if (rows.length === 0) {
    process.stdout.write("no sessions found\n");
    return;
  }
  for (const { session: s, label } of rows) {
    process.stdout.write(`${s.id}  ${dim(formatTimestamp(s.createdAt))}  ${dim(label)}\n`);
  }
}

/**
 * Tear down the current session and load a different one in-place.
 * Mutates ctx: session, logPath, logger, transcript, messages, persistCursor,
 * resumed. Re-emits session_start / memory_loaded into the new transcript.
 */
export async function switchToSession(ctx: CliContext, newSession: Session): Promise<boolean> {
  let newMessages: MessageParam[];
  try {
    newMessages = await loadMessages(newSession.messagesPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(`failed to load messages from ${newSession.id}: ${msg}`, {
      kind: "error",
      title: "/resume",
    });
    ctx.logger.error({ err: msg, target: newSession.id }, "resume failed");
    return false;
  }

  await ctx.transcript.flush();

  ctx.session = newSession;
  ctx.logPath = join(newSession.dir, "session.log");
  ctx.logger = ctx.buildLogger(ctx.logPath);
  ctx.transcript = new Transcript(newSession.transcriptPath);
  ctx.snapshots = new SnapshotStore(join(newSession.dir, "snapshots"));
  await ctx.snapshots.load();
  ctx.persistCursor =
    newMessages.length === 0
      ? emptyCursor
      : {
          count: newMessages.length,
          lastLine: JSON.stringify(newMessages[newMessages.length - 1]),
        };
  ctx.resumed = true;

  await ctx.transcript.append({
    kind: "session_start",
    data: { id: newSession.id, cwd: ctx.workspace, model: ctx.settings.model, resumed: true },
  });
  if (ctx.memory.sources.length > 0) {
    await ctx.transcript.append({ kind: "memory_loaded", data: { sources: ctx.memory.sources } });
  }

  await ctx.screen.reset();
  refreshBanner(ctx);
  ctx.screen.card(
    `${newSession.id}\nlog: ${ctx.logPath}\n${newMessages.length} message(s)`,
    { kind: "info", title: "/resume" },
  );
  const sidecar = await loadDisplaySidecar(newSession.dir);
  ctx.screen.setUserDisplayOverrides(sidecar.userOverrides);
  ctx.screen.setToolDetails(sidecar.toolDetails);
  ctx.screen.setMessages(newMessages);
  ctx.logger.info(
    { sessionId: newSession.id, dir: newSession.dir, messageCount: newMessages.length },
    "session resumed via /resume",
  );
  return true;
}
