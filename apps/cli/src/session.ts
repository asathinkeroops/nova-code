import { join } from "node:path";
import { blocksOf, extractText, type MessageParam } from "@nova/core";
import {
  createSession,
  getSession,
  listSessions,
  type Session,
} from "@nova/runtime";
import { Transcript } from "@nova/observability";
import { dim, red } from "./colors.js";
import { refreshBanner, type CliContext } from "./context.js";
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
  const list = await listSessions(sessionDir);
  type Row = { id: string; createdAt: Date; label: string };
  const rows: Row[] = [];
  for (const s of list) {
    try {
      const msgs = await loadMessages(s.messagesPath);
      if (msgs.length === 0) continue;
      rows.push({ id: s.id, createdAt: s.createdAt, label: firstUserLabel(msgs) });
    } catch (err) {
      const msg = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
      rows.push({
        id: s.id,
        createdAt: s.createdAt,
        label: red(`load failed: ${msg.slice(0, 80)}`),
      });
    }
  }
  if (rows.length === 0) {
    process.stdout.write("no sessions found\n");
    return;
  }
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${dim(formatTimestamp(r.createdAt))}  ${dim(r.label)}\n`);
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
  ctx.screen.setMessages(newMessages);
  ctx.logger.info(
    { sessionId: newSession.id, dir: newSession.dir, messageCount: newMessages.length },
    "session resumed via /resume",
  );
  return true;
}
