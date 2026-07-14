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
import { red } from "./colors.js";
import { refreshBanner, type CliContext } from "./context.js";
import { loadDisplaySidecar } from "./display-sidecar.js";
import { loadCards } from "./card-store.js";
import { loadGoal } from "./goal.js";
import { loadSessionName } from "./session-name.js";
import {
  restoreContextTokensFromTranscript,
  restoreUsageFromTranscript,
} from "./usage-restore.js";
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
 * kept with a red error label. Used by /resume to build its picker rows.
 */
export async function buildSessionRows(sessionDir: string | undefined): Promise<SessionRow[]> {
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

export interface SwitchSessionOptions {
  /** Card / log title. Defaults to "/resume". */
  title?: string;
  /**
   * Whether this is a resume of existing history (true) or a freshly created
   * empty session (false). Recorded in the session_start transcript event.
   * Defaults to true.
   */
  resumed?: boolean;
  /** Card body to show when the target session has no messages. */
  emptyCard?: string;
}

/**
 * Tear down the current session and load a different one in-place.
 * Mutates ctx: session, logPath, logger, transcript, messages, persistCursor,
 * resumed. Re-emits session_start / memory_loaded into the new transcript.
 *
 * Shared by `/resume` (switch to an existing session) and `/clear` (switch to a
 * freshly created empty session). The previous session is left untouched on
 * disk, so it stays resumable.
 */
export async function switchToSession(
  ctx: CliContext,
  newSession: Session,
  opts: SwitchSessionOptions = {},
): Promise<boolean> {
  const title = opts.title ?? "/resume";
  const resumed = opts.resumed ?? true;
  let newMessages: MessageParam[];
  try {
    newMessages = await loadMessages(newSession.messagesPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // persist:false — the switch hasn't committed, so ctx.session still points
    // at the old session; this transient error must not land in its cards file.
    ctx.screen.card(`failed to load messages from ${newSession.id}: ${msg}`, {
      kind: "error",
      title,
      persist: false,
    });
    ctx.logger.error({ err: msg, target: newSession.id }, "session switch failed");
    return false;
  }

  await ctx.transcript.flush();

  // Scheduled tasks are scoped to the outgoing session — tear down its timers,
  // then re-point the store at the incoming session and re-arm its entries. The
  // store instance is reused (the cron tools close over it), only its target dir
  // changes.
  ctx.cronScheduler.dispose();
  ctx.cronStore.retarget(newSession.dir);
  await ctx.cronScheduler.init();

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
  ctx.resumed = resumed;

  await ctx.transcript.append({
    kind: "session_start",
    data: { id: newSession.id, cwd: ctx.workspace, model: ctx.settings.model, resumed },
  });
  // Re-read memory at the session boundary: the prefix is rebuilt for the
  // switched-in session anyway, so picking up on-disk memory edits (incl. the
  // agent's own auto-memory writes from earlier this process) costs nothing
  // cache-wise. The agent reads via getMemory(), so the next turn sees it.
  await ctx.reloadMemory();
  if (ctx.memory.sources.length > 0) {
    await ctx.transcript.append({ kind: "memory_loaded", data: { sources: ctx.memory.sources } });
  }

  const startSource = resumed ? "resume" : "clear";
  await ctx.userHooks.fire("SessionStart", {
    subject: startSource,
    fields: { source: startSource },
  });

  await ctx.screen.reset();
  refreshBanner(ctx);
  const card =
    newMessages.length === 0 && opts.emptyCard
      ? opts.emptyCard
      : `${newSession.id}\nlog: ${ctx.logPath}\n${newMessages.length} message(s)`;
  const sidecar = await loadDisplaySidecar(newSession.dir);
  ctx.screen.setUserDisplayOverrides(sidecar.userOverrides);
  ctx.screen.setToolDetails(sidecar.toolDetails);
  // Restore the switched-in session's persisted cards, then push the ephemeral
  // session-info notice (persist:false so it isn't re-recorded each switch).
  ctx.screen.setCards(await loadCards(newSession.dir));
  ctx.screen.card(card, { kind: "info", title, persist: false });
  ctx.screen.setMessages(newMessages);
  // Carry the switched-in session's active /goal (or null for a fresh one), so
  // auto-continuation follows the session rather than leaking across a switch.
  ctx.goal = await loadGoal(newSession.dir);
  // Re-point the session-name badge at the switched-in session (null for a fresh
  // /clear session) so it tracks the live session rather than leaking across.
  ctx.sessionName = await loadSessionName(newSession.id);
  ctx.screen.setSessionName(ctx.sessionName);
  // Restore the cumulative token counters (cache hit rate / `/usage`) from the
  // switched-in session's transcript. `/clear` lands on a fresh empty session,
  // so its counters stay at the zero set by `screen.reset()` above.
  if (resumed) {
    ctx.screen.seedUsage(await restoreUsageFromTranscript(newSession.transcriptPath));
    // Also rehydrate the context-window meter from the last request's total, so
    // it reads the real occupancy after `/resume` rather than 0% (reset above)
    // until the next model turn.
    ctx.screen.setContextTokens(await restoreContextTokensFromTranscript(newSession.transcriptPath));
  }
  ctx.logger.info(
    { sessionId: newSession.id, dir: newSession.dir, messageCount: newMessages.length, resumed },
    `session switched via ${title}`,
  );
  return true;
}
