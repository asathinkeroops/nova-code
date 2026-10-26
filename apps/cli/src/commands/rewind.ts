import { stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { blocksOf, extractText, type MessageParam } from "@nova/core";
import { isWithin } from "@nova/safety";
import { ACCENT_HEX, dim, green, yellow, red } from "../colors.js";
import { persist, type CliContext } from "../context.js";
import type { RestorePlan } from "../snapshots.js";
import { listWorktrees, repoRoot } from "../worktree.js";
import { pickerArrow } from "../ui/picker.js";
import { t } from "../i18n/index.js";
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
 * Pull out the genuine user prompts from a history. Two things are excluded so
 * the turn numbers line up with what the user actually sent:
 *
 * - A user-role message that carries only tool_results (extractText is empty)
 *   is the loop feeding the model, not something the user typed.
 * - A message marked `meta.synthetic` is a nova injection (todo/task reminder,
 *   background notification, interruption marker, compaction boundary, …) — the
 *   `meta` out-of-band marker, not the in-band `<...>` tag, is the source of
 *   truth, so a user who literally types "<todo-reminder>" still rewinds.
 */
export function collectUserTurns(messages: MessageParam[]): UserTurn[] {
  const turns: UserTurn[] = [];
  messages.forEach((m, index) => {
    if (m.role !== "user") return;
    if (m.meta?.synthetic) return;
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
 * Split a restore plan by reachability.
 *
 * Snapshot records carry ABSOLUTE paths, and a session keeps the same snapshot
 * store across a worktree switch (the store lives in the session dir). So a
 * rewind that crosses a switch legitimately restores files in the checkout
 * where the edit happened — undoing what actually happened is the point. What
 * must not happen is restoring into a checkout that no longer exists: that
 * would `mkdir -p` a removed worktree back into being, unregistered and full of
 * one stale file. Those targets are pulled out and surfaced instead.
 *
 * Only called when some target lies outside the current workspace, so an
 * ordinary session never pays for the git lookup.
 */
export async function partitionRestoreTargets(
  plan: RestorePlan,
  opts: {
    /** Existing checkout roots (the workspace plus every live worktree). */
    roots: readonly string[];
    /** Whether a path's parent directory exists; injectable for tests. */
    parentExists: (path: string) => Promise<boolean>;
  },
): Promise<{ plan: RestorePlan; unreachable: string[] }> {
  const insideCheckout = (path: string): boolean =>
    opts.roots.some((root) => resolve(root) === resolve(path) || isWithin(root, path));
  // Both record kinds describe a path that existed (or was created) while its
  // directory was there. A missing parent now means the checkout — or that
  // whole subtree — was removed; writing into it would resurrect a directory
  // nobody asked for. (Worktrees live INSIDE the repo root, so containment
  // alone cannot tell a removed checkout from the main one.)
  const reachable = async (path: string): Promise<boolean> =>
    insideCheckout(path) && (await opts.parentExists(path));
  const toModify: RestorePlan["toModify"] = [];
  const toRemove: string[] = [];
  const unreachable: string[] = [];
  for (const m of plan.toModify) {
    if (await reachable(m.path)) toModify.push(m);
    else unreachable.push(m.path);
  }
  for (const path of plan.toRemove) {
    if (await reachable(path)) toRemove.push(path);
    else unreachable.push(path);
  }
  return { plan: { ...plan, toModify, toRemove }, unreachable };
}

/** The current workspace plus every registered checkout that still exists. */
async function existingCheckoutRoots(ctx: CliContext): Promise<string[]> {
  const roots = [resolve(ctx.workspace)];
  const repo = ctx.worktree?.main ?? (await repoRoot(ctx.workspace));
  if (!repo) return roots;
  for (const entry of await listWorktrees(repo)) {
    const path = resolve(entry.path);
    if (roots.includes(path)) continue;
    if ((await stat(path).catch(() => null))?.isDirectory()) roots.push(path);
  }
  return roots;
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
    await overlayNotice(ctx, TITLE, [dim(t.rewind.nothingToRewind)]);
    return;
  }

  let target: UserTurn | null;
  if (arg) {
    const n = Number.parseInt(arg, 10);
    if (!Number.isInteger(n) || n < 1 || String(n) !== arg) {
      ctx.screen.card(t.rewind.expectedTurnCount(turns.length), {
        kind: "error",
        title: TITLE,
      });
      return;
    }
    target = turns[turns.length - n] ?? null;
    if (!target) {
      ctx.screen.card(t.rewind.onlyNTurns(turns.length), {
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
      header: dim(t.rewind.pickerHeader),
      footer: dim(t.common.footerNavConfirm),
      pageSize: 10,
      border: false,
      topRuleColor: ACCENT_HEX,
      render: (t, isSelected) => `${pickerArrow(isSelected)} ${dim(`#${t.turn}`)}  ${t.label}`,
    });
    if (!target) return; // esc — leave the feed quiet
  }

  // File restoration: roll any file changed at/after this turn back to its
  // pre-turn state. `target.index` is the message length at the turn's start,
  // which is exactly the epoch the snapshot store tags captures with. Files
  // whose on-disk content has diverged from nova's last write come back as
  // conflicts — shown, but never overwritten.
  let plan = await ctx.snapshots.plan(target.index);
  // Paths from another checkout (a worktree switch earlier in the session) would
  // render as `../../../…`; show them absolute instead.
  const rel = (p: string): string => {
    const r = relative(ctx.workspace, p);
    return r && !r.startsWith("..") ? r : p;
  };
  let unreachable: string[] = [];
  const crossesCheckouts = [...plan.toModify.map((m) => m.path), ...plan.toRemove].some(
    (p) => !isWithin(ctx.workspace, p) && resolve(p) !== resolve(ctx.workspace),
  );
  if (crossesCheckouts) {
    const partitioned = await partitionRestoreTargets(plan, {
      roots: await existingCheckoutRoots(ctx),
      parentExists: async (p) => (await stat(dirname(p)).catch(() => null))?.isDirectory() ?? false,
    });
    plan = partitioned.plan;
    unreachable = partitioned.unreachable;
  }
  const fileCount = plan.toModify.length + plan.toRemove.length;
  if (fileCount > 0 || plan.conflicts.length > 0 || unreachable.length > 0) {
    const header =
      fileCount > 0
        ? t.rewind.restoreHeader(plan.toModify.length, plan.toRemove.length)
        : t.rewind.noneRevertable;
    const conflictNote =
      plan.conflicts.length > 0
        ? [
            "",
            dim(t.rewind.conflictNote(plan.conflicts.length)),
            ...plan.conflicts.map((c) => `  ${yellow("!")} ${rel(c.path)}`),
          ]
        : [];
    const unreachableNote =
      unreachable.length > 0
        ? [
            "",
            dim(t.rewind.unreachableNote(unreachable.length)),
            ...unreachable.map((p) => `  ${red("?")} ${rel(p)}`),
          ]
        : [];
    const preview = [
      dim(header),
      ...plan.toModify.map((m) => `  ${green("~")} ${rel(m.path)}`),
      ...plan.toRemove.map((p) => `  ${red("-")} ${rel(p)}`),
      ...conflictNote,
      ...unreachableNote,
    ].join("\n");
    const confirm = await ctx.screen.pickHorizontal<boolean>({
      items: [true, false],
      header: preview,
      footer: dim(t.rewind.confirmFooter),
      label: (ok) =>
        ok
          ? fileCount > 0
            ? t.rewind.restoreAndRewind
            : t.rewind.rewindHistoryOnly
          : t.rewind.cancel,
      border: false,
      topRuleColor: ACCENT_HEX,
    });
    if (confirm === null) return; // esc — leave the feed quiet
    if (!confirm) {
      // Deliberate "cancel" selection (not esc) still gets a note.
      ctx.screen.card(dim(t.rewind.cancelledNothingChanged), { title: TITLE });
      return;
    }
    try {
      await ctx.snapshots.restore(plan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.screen.card(t.rewind.restoreFailed(msg), { kind: "error", title: TITLE });
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
  // The transcript never rolls back, so record the cut: without it the two
  // files disagree about which turns exist and nothing on disk explains why.
  await ctx.transcript.append({
    kind: "rewind",
    data: { toIndex: target.index, dropped, turn: target.turn },
  });
  await ctx.screen.reset();
  // Truncating history invalidates every card anchored past the rewind point
  // (same problem compaction has) — drop the persisted cards so stale-anchored
  // ones don't resurface on resume. reset() only clears the in-memory copy.
  ctx.screen.clearCards();
  const fileNote = fileCount > 0 ? t.rewind.fileNote(fileCount) : "";
  const skipNote = plan.conflicts.length > 0 ? t.rewind.skipNote(plan.conflicts.length) : "";
  const missingNote = unreachable.length > 0 ? t.rewind.unreachableSummary(unreachable.length) : "";
  ctx.screen.card(
    dim(t.rewind.rewoundSummary({ turn: target.turn, dropped, fileNote, skipNote, missingNote })),
    { title: TITLE },
  );
  ctx.screen.setMessages(truncated);
  ctx.nextPlaceholder = target.text;
}
