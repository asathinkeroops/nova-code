import { relative } from "node:path";
import { blocksOf, extractText, type MessageParam } from "@nova/core";
import { dim, green, red } from "../colors.js";
import { persist, type CliContext } from "../context.js";
import { pickerArrow } from "../ui/picker.js";

const TITLE = "/rewind";

export interface UserTurn {
  /** Position of this user message in the full `messages` array. */
  index: number;
  /** 1-based ordinal among genuine user prompts (oldest = 1). */
  turn: number;
  /** Single-line, truncated label for the picker. */
  label: string;
  /** Full prompt text, restored into the input box on rewind. */
  text: string;
}

/**
 * Pull out the genuine user prompts from a history. A user-role message that
 * carries only tool_results (extractText is empty) is the loop feeding the
 * model, not something the user typed — those are skipped so the turn numbers
 * line up with what the user actually sent.
 */
export function collectUserTurns(messages: MessageParam[]): UserTurn[] {
  const turns: UserTurn[] = [];
  messages.forEach((m, index) => {
    if (m.role !== "user") return;
    const text = extractText(blocksOf(m)).trim();
    if (!text) return;
    const flat = text.replace(/\s+/g, " ");
    turns.push({
      index,
      turn: turns.length + 1,
      text,
      label: flat.length > 80 ? `${flat.slice(0, 77)}...` : flat,
    });
  });
  return turns;
}

/**
 * Rewind the conversation to just before a previous user message: history
 * after the chosen turn is discarded and the message itself is placed back in
 * the input box for editing/resending. Does not touch files on disk — only the
 * model context and `messages.jsonl`.
 *
 * `/rewind` with no arg opens a picker (newest turn pre-selected). `/rewind N`
 * counts back from the most recent turn (1 = undo the last exchange).
 */
export async function handleRewind(ctx: CliContext, arg: string): Promise<void> {
  const messages = ctx.screen.getMessages();
  const turns = collectUserTurns(messages);
  if (turns.length === 0) {
    ctx.screen.card(dim("nothing to rewind to."), { title: TITLE });
    return;
  }

  let target: UserTurn | null;
  if (arg) {
    const n = Number.parseInt(arg, 10);
    if (!Number.isInteger(n) || n < 1 || String(n) !== arg) {
      ctx.screen.card(`expected a turn count (1-${turns.length}).`, {
        kind: "error",
        title: TITLE,
      });
      return;
    }
    target = turns[turns.length - n] ?? null;
    if (!target) {
      ctx.screen.card(`only ${turns.length} user turn(s) to rewind through.`, {
        kind: "error",
        title: TITLE,
      });
      return;
    }
  } else {
    // Newest first so the most recent turn is the default (top) selection.
    const ordered = [...turns].reverse();
    target = await ctx.screen.pickOne<UserTurn>({
      items: ordered,
      header: dim("rewind to which message? everything after it is discarded:"),
      footer: dim("↑↓ navigate · enter confirm · esc cancel"),
      pageSize: 10,
      border: false,
      render: (t, isSelected) => `${pickerArrow(isSelected)} ${dim(`#${t.turn}`)}  ${t.label}`,
    });
    if (!target) {
      ctx.screen.card(dim("cancelled."), { title: TITLE });
      return;
    }
  }

  // File restoration: roll any file changed at/after this turn back to its
  // pre-turn state. `target.index` is the message length at the turn's start,
  // which is exactly the epoch the snapshot store tags captures with.
  const plan = ctx.snapshots.plan(target.index);
  const fileCount = plan.toModify.length + plan.toRemove.length;
  if (fileCount > 0) {
    const rel = (p: string): string => relative(ctx.workspace, p) || p;
    const preview = [
      dim(`will restore ${plan.toModify.length} file(s), delete ${plan.toRemove.length} newly-created file(s):`),
      ...plan.toModify.map((m) => `  ${green("~")} ${rel(m.path)}`),
      ...plan.toRemove.map((p) => `  ${red("-")} ${rel(p)}`),
    ].join("\n");
    const confirm = await ctx.screen.pickHorizontal<boolean>({
      items: [true, false],
      header: preview,
      footer: dim("←→ navigate · enter confirm · esc cancel"),
      label: (ok) => (ok ? "restore & rewind" : "cancel"),
    });
    if (!confirm) {
      ctx.screen.card(dim("cancelled; nothing changed."), { title: TITLE });
      return;
    }
    try {
      await ctx.snapshots.restore(plan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.screen.card(`file restore failed: ${msg}`, { kind: "error", title: TITLE });
      ctx.logger.error({ err: msg }, "rewind file restore failed");
      return;
    }
  }

  const dropped = messages.length - target.index;
  const truncated = messages.slice(0, target.index);

  // Persist the shrunk history first (this hits persistMessages' atomic-rewrite
  // path), then repaint a clean screen with the truncated timeline.
  ctx.screen.setMessages(truncated);
  await persist(ctx);
  await ctx.screen.reset();
  const fileNote = fileCount > 0 ? ` restored ${fileCount} file(s).` : "";
  ctx.screen.card(
    dim(
      `rewound to turn #${target.turn}; dropped ${dropped} message(s).${fileNote} ` +
        `your message is back in the prompt (→ to edit).`,
    ),
    { title: TITLE },
  );
  ctx.screen.setMessages(truncated);
  ctx.nextPlaceholder = target.text;
}
