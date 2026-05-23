import { join } from "node:path";
import { blocksOf, extractText, type MessageParam } from "@nova/core";
import {
  createSession,
  getSession,
  listSessions,
  type Session,
} from "@nova/runtime";
import { Transcript } from "@nova/observability";
import { dim, green, red } from "./colors.js";
import { clearScreen, printBanner, type CliContext } from "./context.js";
import { renderMarkdown } from "./markdown.js";
import { loadMessages, emptyCursor } from "./persistence.js";
import {
  renderRedactedThinking,
  renderThinking,
  renderToolResult,
  renderToolUse,
} from "./renderers.js";

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
      console.error(`session ${opts.resume} not found`);
      process.exit(2);
    }
    return { session: found, resumed: true };
  }
  if (opts.continue) {
    const list = await listSessions(sessionDir);
    if (list.length === 0) {
      console.error("no sessions to continue");
      process.exit(2);
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

export function renderHistory(msgs: MessageParam[]): void {
  if (msgs.length === 0) return;
  process.stdout.write(`\n${dim("─── history ───")}\n`);
  const toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const msg of msgs) {
    const blocks = blocksOf(msg);
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        process.stdout.write(`\n${green(">")} ${msg.content}\n`);
        continue;
      }
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const pending = toolUses.get(block.tool_use_id);
          process.stdout.write(
            `\n${renderToolResult(pending?.name, { is_error: block.is_error, content: block.content }, pending?.input)}\n`,
          );
          if (pending) toolUses.delete(block.tool_use_id);
        } else if (block.type === "text") {
          process.stdout.write(`\n${green(">")} ${block.text}\n`);
        }
      }
      continue;
    }
    for (const block of blocks) {
      if (block.type === "text") {
        if (block.text.trim().length > 0) {
          process.stdout.write(`\n${renderMarkdown(block.text)}\n`);
        }
      } else if (block.type === "tool_use") {
        toolUses.set(block.id, { name: block.name, input: block.input });
        process.stdout.write(`\n${renderToolUse(block)}\n`);
      } else if (block.type === "thinking") {
        process.stdout.write(`\n${renderThinking(block.thinking)}\n`);
      } else if (block.type === "redacted_thinking") {
        process.stdout.write(`\n${renderRedactedThinking()}\n`);
      }
    }
  }
  process.stdout.write(`\n${dim("─── end of history ───")}\n`);
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
    process.stderr.write(`${red(`✗ failed to load messages from ${newSession.id}: ${msg}`)}\n`);
    ctx.logger.error({ err: msg, target: newSession.id }, "resume failed");
    return false;
  }

  await ctx.transcript.flush();

  ctx.session = newSession;
  ctx.logPath = join(newSession.dir, "session.log");
  ctx.logger = ctx.buildLogger(ctx.logPath);
  ctx.transcript = new Transcript(newSession.transcriptPath);
  ctx.messages = newMessages;
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

  clearScreen();
  printBanner(ctx);
  process.stdout.write(
    `${dim(`↻ resumed ${newSession.id} · log: ${ctx.logPath} · ${newMessages.length} message(s)`)}\n`,
  );
  renderHistory(newMessages);
  ctx.logger.info(
    { sessionId: newSession.id, dir: newSession.dir, messageCount: newMessages.length },
    "session resumed via /resume",
  );
  return true;
}
