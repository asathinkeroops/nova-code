import { resolve } from "node:path";
import {
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  createWorktreeTools,
  type EnterWorktreeInput,
  type EnterWorktreeResult,
  type ExitWorktreeInput,
  type WorktreeHost,
  type WorktreeSessionInfo,
} from "@nova/tools";
import type { CliContext } from "./ctx-types.js";
import {
  addWorktree,
  repoRoot,
  worktreeBinding,
  type AddWorktreeOptions,
  type WorktreeBinding,
} from "./worktree.js";

/**
 * CLI-side implementation of the worktree tools.
 *
 * The tools live in `@nova/tools` because the model sees them, but moving the
 * session is the CLI's job: `ctx.setWorkspace` rebuilds the memory bundle,
 * permission roots, sandbox allowlist, LSP root, session binding and prompt
 * epoch. This file is the only place that couples the two, and it mirrors the
 * rules the CLI has always enforced when moving a session:
 *
 *  - `enter` by name creates/reuses a checkout through `addWorktree` (the same
 *    idempotent path `--worktree` uses) and then moves the session;
 *  - `enter` by path only accepts a LINKED worktree of this repository — the
 *    main checkout is `exit`'s job, not `enter`'s;
 *  - `exit` returns to the main checkout, or to an explicit checkout root when
 *    git metadata cannot name one (`--separate-git-dir` + linked worktree).
 *
 * Both tools are withheld from every sub-agent (see `excludeTools` in
 * context.ts): a child shares the parent's session, so entering a worktree
 * from a child would move the parent mid-turn.
 */

export interface WorktreeToolDeps {
  addWorktree: (opts: AddWorktreeOptions) => ReturnType<typeof addWorktree>;
  worktreeBinding: (dir: string) => ReturnType<typeof worktreeBinding>;
  repoRoot: (dir: string) => ReturnType<typeof repoRoot>;
}

const DEFAULT_DEPS: WorktreeToolDeps = { addWorktree, worktreeBinding, repoRoot };

function sessionInfo(binding: WorktreeBinding): WorktreeSessionInfo {
  return {
    path: binding.path,
    ...(binding.branch ? { branch: binding.branch } : {}),
    ...(binding.main ? { main: binding.main } : {}),
  };
}

export function createWorktreeHost(
  ctx: CliContext,
  deps: WorktreeToolDeps = DEFAULT_DEPS,
): WorktreeHost {
  const enter = async (input: EnterWorktreeInput): Promise<EnterWorktreeResult> => {
    if (!ctx.settings.worktree.enabled) {
      throw new Error("worktrees are disabled (settings.worktree.enabled = false)");
    }

    if (input.name !== undefined) {
      const created = await deps.addWorktree({
        repo: ctx.workspace,
        name: input.name,
        dir: ctx.settings.worktree.dir,
        baseRef: ctx.settings.worktree.baseRef,
        includeFile: ctx.settings.worktree.includeFile,
        ...(input.from !== undefined ? { from: input.from } : {}),
      });
      const current = ctx.worktree;
      if (current && resolve(current.path) === resolve(created.path)) {
        return {
          ...sessionInfo(current),
          created: false,
          alreadyHere: true,
          copied: created.copied,
          skipped: created.skipped,
          failed: created.failed,
        };
      }
      const binding = await ctx.setWorkspace(created.path);
      if (!binding) {
        throw new Error(`the session did not enter a linked worktree at ${created.path}`);
      }
      return {
        ...sessionInfo(binding),
        created: created.created,
        copied: created.copied,
        skipped: created.skipped,
        failed: created.failed,
      };
    }

    // `path` is the switch-between-existing-worktrees branch. The schema
    // guarantees exactly one of name/path, so `input.path` is defined here.
    const target = resolve(ctx.workspace, input.path ?? "");
    const binding = await deps.worktreeBinding(target);
    if (!binding) {
      throw new Error(
        `${target} is not a linked worktree of this repository. ` +
          `Use ${EXIT_WORKTREE_TOOL_NAME} to return to the main checkout.`,
      );
    }
    if (resolve(binding.path) === resolve(ctx.workspace)) {
      return { ...sessionInfo(binding), created: false, alreadyHere: true };
    }
    const switched = await ctx.setWorkspace(binding.path);
    if (!switched) {
      throw new Error(`the session stayed in ${ctx.workspace}: ${binding.path} is a main checkout`);
    }
    return { ...sessionInfo(switched), created: false };
  };

  const exit = async (input: ExitWorktreeInput): Promise<WorktreeSessionInfo> => {
    const current = ctx.worktree;
    if (!current) {
      throw new Error("this session is not in a worktree; there is nothing to exit.");
    }
    const target = input.path !== undefined ? resolve(ctx.workspace, input.path) : current.main;
    if (!target) {
      throw new Error(
        "cannot locate the main checkout: this repository keeps its git directory outside " +
          "the working tree. Pass `path` with the main checkout, or start a new session there.",
      );
    }
    // Exit means "a checkout root that is NOT a linked worktree". Requiring the
    // root (rather than accepting a subdirectory) keeps the session's workspace
    // at a real checkout, which is what all the workspace-scoped state assumes.
    const top = await deps.repoRoot(target);
    if (!top || resolve(top) !== resolve(target)) {
      throw new Error(`${target} is not a checkout root of this repository`);
    }
    if (await deps.worktreeBinding(target)) {
      throw new Error(
        `${target} is a linked worktree; use ${ENTER_WORKTREE_TOOL_NAME} to switch between worktrees.`,
      );
    }
    await ctx.setWorkspace(target);
    if (ctx.worktree) {
      throw new Error(`the session is still in a worktree (${ctx.worktree.path})`);
    }
    return { path: ctx.workspace };
  };

  return { enter, exit };
}

/**
 * Register the tools on the live registry. Only when worktrees are enabled:
 * a disabled feature should not advertise two tools the model can never use.
 *
 * Registration happens BEFORE `permissions.deny` is applied, so a user can
 * remove either tool by name like any other builtin.
 */
export function registerWorktreeTools(ctx: CliContext): void {
  if (!ctx.settings.worktree.enabled) return;
  ctx.tools.registerAll(createWorktreeTools(createWorktreeHost(ctx)));
}
