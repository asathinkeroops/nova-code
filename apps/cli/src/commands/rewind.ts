import { relative } from "node:path";
import { blocksOf, extractText, type MessageParam } from "@nova/core";
import { dim, green, PURPLE_HEX, red, yellow } from "../colors.js";
import { persist, type CliContext } from "../context.js";
import { pickerArrow } from "../ui/picker.js";
import { overlayNotice } from "./overlay-notice.js";

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
 * the input box for editing/resending. Files that `write`/`edit` touched at or
 * after that turn are also rolled back to their pre-turn state (via the
 * snapshot store) — modified files restored, newly-created files deleted —
 * after a confirmation preview. A file whose current content has diverged from
 * what nova last wrote (edited by `bash`, a sub-agent, another session, git, or
 * by hand) is shown as a conflict and left untouched, so rewind never clobbers
 * changes nova didn't make. Side effects from `bash` (rm, sed -i, redirects)
 * are likewise not snapshotted and so are left as-is.
 *
 * `/rewind` with no arg opens a picker (newest turn pre-selected). `/rewind N`
 * counts back from the most recent turn (1 = undo the last exchange).
 */
export async function handleRewind(ctx: CliContext, arg: string): Promise<void> {
  const messages = ctx.screen.getMessages();
  const turns = collectUserTurns(messages);
  if (turns.length === 0) {
    await overlayNotice(ctx, TITLE, [dim("nothing to rewind to.")]);
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
      topRuleColor: PURPLE_HEX,
      render: (t, isSelected) => `${pickerArrow(isSelected)} ${dim(`#${t.turn}`)}  ${t.label}`,
    });
    if (!target) return; // esc — leave the feed quiet
  }

  // File restoration: roll any file changed at/after this turn back to its
  // pre-turn state. `target.index` is the message length at the turn's start,
  // which is exactly the epoch the snapshot store tags captures with. Files
  // whose on-disk content has diverged from nova's last write come back as
  // conflicts — shown, but never overwritten.
  const plan = await ctx.snapshots.plan(target.index);
  const fileCount = plan.toModify.length + plan.toRemove.length;
  if (fileCount > 0 || plan.conflicts.length > 0) {
    const rel = (p: string): string => relative(ctx.workspace, p) || p;
    const header =
      fileCount > 0
        ? `will restore ${plan.toModify.length} file(s), delete ${plan.toRemove.length} newly-created file(s):`
        : "no files can be auto-reverted (all changed outside nova):";
    const conflictNote =
      plan.conflicts.length > 0
        ? [
            "",
            dim(
              `${plan.conflicts.length} file(s) changed outside nova since that turn ` +
                `— left untouched to avoid clobbering newer work:`,
            ),
            ...plan.conflicts.map((c) => `  ${yellow("!")} ${rel(c.path)}`),
          ]
        : [];
    const preview = [
      dim(header),
      ...plan.toModify.map((m) => `  ${green("~")} ${rel(m.path)}`),
      ...plan.toRemove.map((p) => `  ${red("-")} ${rel(p)}`),
      ...conflictNote,
    ].join("\n");
    const confirm = await ctx.screen.pickHorizontal<boolean>({
      items: [true, false],
      header: preview,
      footer: dim("←→ navigate · enter confirm · esc cancel"),
      label: (ok) => (ok ? (fileCount > 0 ? "restore & rewind" : "rewind history only") : "cancel"),
      border: false,
      topRuleColor: PURPLE_HEX,
    });
    if (confirm === null) return; // esc — leave the feed quiet
    if (!confirm) {
      // Deliberate "cancel" selection (not esc) still gets a note.
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
  // Truncating history invalidates every card anchored past the rewind point
  // (same problem compaction has) — drop the persisted cards so stale-anchored
  // ones don't resurface on resume. reset() only clears the in-memory copy.
  ctx.screen.clearCards();
  const fileNote = fileCount > 0 ? ` restored ${fileCount} file(s).` : "";
  const skipNote =
    plan.conflicts.length > 0 ? ` skipped ${plan.conflicts.length} file(s) changed outside nova.` : "";
  ctx.screen.card(
    dim(
      `rewound to turn #${target.turn}; dropped ${dropped} message(s).${fileNote}${skipNote} ` +
        `your message is back in the prompt (→ to edit).`,
    ),
    { title: TITLE },
  );
  ctx.screen.setMessages(truncated);
  ctx.nextPlaceholder = target.text;
}
