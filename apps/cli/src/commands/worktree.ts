import { ACCENT_HEX, dim, green, red } from "../colors.js";
import { refreshBanner, type CliContext } from "../context.js";
import { listWorkspaceFiles } from "../file-index.js";
import { t } from "../i18n/index.js";
import { pickerArrow } from "../ui/picker.js";
import {
  addWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  repoRoot,
  worktreeChangeCount,
  type WorktreeEntry,
} from "../worktree.js";

const TITLE = "/worktree";

/** The repository this session belongs to: its main checkout. */
async function repoFor(ctx: CliContext): Promise<string | undefined> {
  return ctx.worktree?.main ?? (await repoRoot(ctx.workspace));
}

function isMainCheckout(entry: WorktreeEntry, repo: string): boolean {
  return entry.path === repo;
}

/**
 * Parse `new <name> [from <ref>]`.
 *
 * The keyword is explicit on purpose: the old code took the next token blindly
 * and documented the syntax with `from`, so `/worktree new x from HEAD` tried to
 * start from a ref literally named "from" — a silent wrong base when such a ref
 * exists. A bare extra token is rejected too (it is not the documented form).
 */
export interface NewWorktreeArgs {
  name: string;
  from?: string;
}

export function parseNewWorktreeArgs(tokens: readonly string[]): NewWorktreeArgs | undefined {
  const [name, ...tail] = tokens;
  if (!name) return undefined;
  if (tail.length === 0) return { name };
  if (tail[0] !== "from") return undefined;
  const from = tail[1];
  if (!from || tail.length > 2) return undefined;
  return { name, from };
}

/** `new <name> [from <ref>]` | `enter <name>` | `remove <name>` | `prune` | list. */
export async function handleWorktree(ctx: CliContext, arg: string): Promise<void> {
  const [verb = "", ...rest] = arg.trim().split(/\s+/).filter(Boolean);
  const repo = await repoFor(ctx);
  if (!repo) {
    ctx.screen.card(t.worktree.notRepo(ctx.workspace), { kind: "error", title: TITLE });
    return;
  }
  if (!ctx.settings.worktree.enabled) {
    ctx.screen.card(t.worktree.disabled, { kind: "warn", title: TITLE });
    return;
  }

  switch (verb) {
    case "":
    case "list":
      await renderList(ctx, repo);
      return;
    case "new": {
      const parsed = parseNewWorktreeArgs(rest);
      if (!parsed) {
        ctx.screen.card(t.worktree.usage(TITLE), { kind: "error", title: TITLE });
        return;
      }
      // Creation takes the CURRENT checkout as its source, not the main one:
      // `addWorktree` derives the layout root itself, while the start point
      // (`HEAD`, `baseRef`) and the `.worktreeinclude` files belong to the
      // checkout the user is looking at. List/remove/prune stay repo-wide.
      await createAndEnter(ctx, ctx.workspace, parsed.name, parsed.from);
      return;
    }
    case "enter":
      await enter(ctx, repo, rest[0]);
      return;
    case "remove":
      await remove(ctx, repo, rest[0]);
      return;
    case "prune":
      ctx.screen.card(t.worktree.pruned(await pruneWorktrees(repo)), { title: TITLE });
      return;
    default:
      ctx.screen.card(t.worktree.usage(TITLE), { kind: "error", title: TITLE });
  }
}

async function renderList(ctx: CliContext, repo: string): Promise<void> {
  const entries = await listWorktrees(repo);
  if (entries.length === 0) {
    ctx.screen.card(dim(t.worktree.none), { title: TITLE });
    return;
  }
  const lines = await Promise.all(
    entries.map(async (entry) => {
      const here = entry.path === ctx.workspace;
      const marker = here ? green("*") : " ";
      const main = isMainCheckout(entry, repo) ? dim(` ${t.worktree.mainLabel}`) : "";
      const dirty = await worktreeChangeCount(entry.path);
      const state =
        dirty < 0
          ? dim(t.worktree.stateUnknown)
          : dirty > 0
            ? red(t.worktree.dirty(dirty))
            : green(t.worktree.clean);
      const branch = entry.branch ?? (entry.detached ? dim("(detached)") : "");
      return `${marker} ${branch}${main}\n   ${dim(entry.path)}  ${state}`;
    }),
  );
  ctx.screen.card(`${dim(t.worktree.listHeader)}\n\n${lines.join("\n\n")}`, { title: TITLE });
}

async function createAndEnter(
  ctx: CliContext,
  /** The checkout the session is in — the source for HEAD and included files. */
  source: string,
  name: string | undefined,
  startPoint: string | undefined,
): Promise<void> {
  if (!name) {
    ctx.screen.card(t.worktree.usage(TITLE), { kind: "error", title: TITLE });
    return;
  }
  if (!(await confirmSwitch(ctx))) return;

  const spinner = ctx.screen.startSpinner({ words: [t.worktree.creating(name)] });
  ctx.spinner = spinner;
  try {
    const created = await addWorktree({
      repo: source,
      name,
      dir: ctx.settings.worktree.dir,
      baseRef: ctx.settings.worktree.baseRef,
      includeFile: ctx.settings.worktree.includeFile,
      ...(startPoint ? { from: startPoint } : {}),
    });
    await enterCheckout(ctx, created.path, created.branch);
    const copied =
      created.copied > 0 || created.skipped > 0 || created.failed > 0
        ? `\n${dim(t.worktree.includeCopied(created.copied, created.skipped, created.failed))}`
        : "";
    ctx.screen.card(
      `${created.created ? t.worktree.created(created.path, created.branch) : t.worktree.reused(created.path, created.branch)}${copied}`,
      { kind: "info", title: TITLE },
    );
  } catch (err) {
    stopSpinnerSafely(ctx);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(msg, { kind: "error", title: TITLE });
    return;
  }
  stopSpinnerSafely(ctx);
}

async function enter(ctx: CliContext, repo: string, name: string | undefined): Promise<void> {
  if (!name) {
    ctx.screen.card(t.worktree.usage(TITLE), { kind: "error", title: TITLE });
    return;
  }
  const entries = await listWorktrees(repo);
  const target = entries.find(
    (e) => e.path === name || e.path.endsWith(`/${name}`) || e.branch === name,
  );
  if (!target) {
    ctx.screen.card(t.worktree.unknownName(name), { kind: "error", title: TITLE });
    return;
  }
  if (isMainCheckout(target, repo)) {
    ctx.screen.card(t.worktree.isMain(target.path), { kind: "warn", title: TITLE });
    return;
  }
  if (target.path === ctx.workspace) {
    ctx.screen.card(t.worktree.alreadyHere(target.path), { title: TITLE });
    return;
  }
  if (!(await confirmSwitch(ctx))) return;
  try {
    await enterCheckout(ctx, target.path, target.branch ?? "");
    ctx.screen.card(t.worktree.entered(target.path), { kind: "info", title: TITLE });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(msg, { kind: "error", title: TITLE });
  }
}

/**
 * Move the session. `setWorkspace` rebuilds everything workspace-scoped in the
 * context — this function only handles the UI-visible consequences (banner, the
 * `@`-mention index, transcript card).
 */
async function enterCheckout(ctx: CliContext, path: string, branch: string): Promise<void> {
  await ctx.setWorkspace(path);
  refreshBanner(ctx);
  try {
    ctx.screen.setMentionFiles(await listWorkspaceFiles(ctx.workspace));
  } catch (err) {
    ctx.logger.warn({ err: String(err) }, "failed to refresh @-mention file index");
  }
  ctx.screen.card(
    `${t.worktree.switched(ctx.workspace, branch || "HEAD")}\n${dim(t.worktree.switchedHint)}`,
    { title: TITLE },
  );
}

async function remove(ctx: CliContext, repo: string, name: string | undefined): Promise<void> {
  if (!name) {
    ctx.screen.card(t.worktree.usage(TITLE), { kind: "error", title: TITLE });
    return;
  }
  const entries = await listWorktrees(repo);
  const target = entries.find(
    (e) => e.path === name || e.path.endsWith(`/${name}`) || e.branch === name,
  );
  if (!target) {
    ctx.screen.card(t.worktree.unknownName(name), { kind: "error", title: TITLE });
    return;
  }
  if (isMainCheckout(target, repo)) {
    ctx.screen.card(t.worktree.isMain(target.path), { kind: "warn", title: TITLE });
    return;
  }
  if (target.path === ctx.workspace) {
    ctx.screen.card(t.worktree.inUse(target.path), { kind: "error", title: TITLE });
    return;
  }
  // Removing a checkout discards its work; require a clean tree, the same rule
  // `git worktree remove` applies without --force. `-1` means the count could
  // not be determined — skip the pre-check and let git itself refuse a dirty
  // tree, rather than reading "unknown" as "clean" here.
  const dirty = await worktreeChangeCount(target.path);
  if (dirty > 0) {
    ctx.screen.card(t.worktree.removeDirty(dirty, target.path), { kind: "error", title: TITLE });
    return;
  }
  try {
    await removeWorktree({ repo, path: target.path });
    ctx.screen.card(t.worktree.removed(target.path), { title: TITLE });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(msg, { kind: "error", title: TITLE });
  }
}

/**
 * Moving a live conversation to another checkout is harmless (the history and
 * the session dir stay put), but it is not what a user typing mid-task expects
 * from a stray command — ask once, and only when there IS history to move.
 */
async function confirmSwitch(ctx: CliContext): Promise<boolean> {
  if (ctx.screen.getMessages().length === 0) return true;
  const pick = await ctx.screen.pickOne<{ go: boolean }>({
    items: [{ go: true }, { go: false }],
    footer: dim(t.common.footerNavConfirm),
    border: false,
    topRuleColor: ACCENT_HEX,
    render: (item, selected) =>
      `${pickerArrow(selected)} ${item.go ? t.worktree.confirmSwitch : t.worktree.cancel}`,
  });
  return pick?.go === true;
}

function stopSpinnerSafely(ctx: CliContext): void {
  ctx.spinner?.stop();
  ctx.spinner = null;
}
