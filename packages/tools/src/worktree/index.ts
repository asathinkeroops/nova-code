import { z } from "zod";
import type { ToolHandler, ToolPromptSection, ToolRunResult } from "@nova/core";
import { presentList } from "../prompt.js";

/**
 * Git-worktree tools.
 *
 * These are deliberately HOST-OWNED: `enterWorktree` moves the whole session
 * (tool cwd, permission roots, sandbox allowlist, LSP root, system prompt and
 * session binding), which is the CLI's `setWorkspace` — not something a shell
 * command can do. The host supplies a {@link WorktreeHost}; `@nova/tools` only
 * owns the schema, the model-facing text and the error surface. That keeps this
 * package free of any CLI or git dependency.
 *
 * A sub-agent must never receive these tools: it shares the parent's session,
 * so calling one would move the PARENT's workspace mid-turn. The CLI excludes
 * them from every child (see `excludeTools` in `apps/cli/src/context.ts`).
 */

export const ENTER_WORKTREE_TOOL_NAME = "enterWorktree";
export const EXIT_WORKTREE_TOOL_NAME = "exitWorktree";
export const WORKTREE_TOOL_NAMES: readonly string[] = [
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
];

/** The checkout a session is working in, as reported back to the model. */
export interface WorktreeSessionInfo {
  path: string;
  branch?: string;
  /** Main checkout, when git metadata can name it. */
  main?: string;
}

export interface EnterWorktreeResult extends WorktreeSessionInfo {
  /** False when an existing registered worktree at that path was reused. */
  created: boolean;
  /** True when the session was already in the requested worktree. */
  alreadyHere?: boolean;
  /** Gitignored files copied from `.worktreeinclude` (0 when none matched). */
  copied?: number;
  /** Candidates skipped because copying would clobber tracked/existing content. */
  skipped?: number;
  /** Candidates that matched and passed the checks but could not be copied. */
  failed?: number;
}

/** Enter by `name` (create/reuse) or by `path` (an existing linked worktree). */
export interface EnterWorktreeInput {
  name?: string;
  path?: string;
  /** Start point for a newly created worktree; only valid with `name`. */
  from?: string;
}

export interface ExitWorktreeInput {
  /**
   * Explicit main-checkout path. Needed only when git metadata cannot name it
   * (`git init --separate-git-dir` combined with a linked worktree).
   */
  path?: string;
}

/**
 * What the CLI must implement. Every method either moves the live session and
 * resolves with its new location, or throws with a user-facing message.
 */
export interface WorktreeHost {
  enter(input: EnterWorktreeInput): Promise<EnterWorktreeResult>;
  exit(input: ExitWorktreeInput): Promise<WorktreeSessionInfo>;
}

const enterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Worktree name: letters, digits, '.', '_' or '-' (max 64, no leading dot). " +
          "Creates it under the repository's worktree directory on branch `worktree-<name>`, " +
          "or reuses the existing one at that path.",
      ),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute or workspace-relative path of an EXISTING linked worktree of this repository. " +
          "Use this to switch between worktrees; use `name` to create one.",
      ),
    from: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Commit-ish the new worktree starts from (branch, tag or SHA). Only valid with `name`; " +
          "it overrides the configured `worktree.baseRef`.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.name === undefined) === (value.path === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pass exactly one of `name` (create/reuse) or `path` (enter an existing worktree)",
      });
    }
    if (value.from !== undefined && value.name === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`from` only applies when creating or reusing by `name`",
      });
    }
  });

const exitSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Main checkout to return to. Only needed when nova cannot derive it " +
          "(`git init --separate-git-dir` layouts); normally omit it.",
      ),
  })
  .strict();

const ENTER_DESCRIPTION =
  "Create or reuse a git worktree of the current repository and move THIS SESSION into it. " +
  "Pass `name` to create/reuse a worktree (optionally `from` a commit-ish), or `path` to enter " +
  "an existing linked worktree. This moves the whole session — tool working directory, " +
  "permission roots, sandbox allowlist and system prompt — not just one command's directory. " +
  "A newly created worktree is a fresh checkout (dependencies are not installed) and its `.git` " +
  "is a file pointing at the shared metadata. Do not run `git worktree add` yourself; use this tool. " +
  "Call this tool alone in a model response — other tool calls in the same response are deferred " +
  "until the switch completes.";

const EXIT_DESCRIPTION =
  "Move THIS SESSION back from the current git worktree to the main checkout. Only valid while " +
  "the session is in a worktree. Use this instead of `cd` or redirecting git at the main " +
  "checkout — the worktree isolation guard blocks those. Call this tool alone in a model " +
  "response — other tool calls in the same response are deferred until the switch completes.";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatEnter(result: EnterWorktreeResult): string {
  const lines: string[] = [
    result.alreadyHere ? `Already in worktree ${result.path}.` : `Entered worktree ${result.path}.`,
  ];
  if (result.branch) lines.push(`Branch: ${result.branch}`);
  if (result.main) lines.push(`Main checkout: ${result.main}`);
  if (result.created) {
    lines.push("This is a fresh checkout: install dependencies before running builds or tests.");
  }
  if ((result.copied ?? 0) + (result.skipped ?? 0) + (result.failed ?? 0) > 0) {
    lines.push(
      `Copied ${result.copied ?? 0} gitignored file(s); skipped ${result.skipped ?? 0}; ` +
        `failed ${result.failed ?? 0}.`,
    );
  }
  return lines.join("\n");
}

export function createEnterWorktreeTool(host: WorktreeHost): ToolHandler {
  return {
    definition: {
      name: ENTER_WORKTREE_TOOL_NAME,
      description: ENTER_DESCRIPTION,
      inputSchema: enterSchema,
      exclusive: true,
    },
    // Defense in depth: the loop already defers siblings, but a direct
    // dispatch (or two switches from different callers) must not interleave.
    executionKey: () => "session-workspace",
    async run(rawInput): Promise<ToolRunResult> {
      const input = enterSchema.parse(rawInput) as EnterWorktreeInput;
      try {
        return { output: formatEnter(await host.enter(input)) };
      } catch (err) {
        return { output: `${ENTER_WORKTREE_TOOL_NAME} failed: ${message(err)}`, isError: true };
      }
    },
  };
}

export function createExitWorktreeTool(host: WorktreeHost): ToolHandler {
  return {
    definition: {
      name: EXIT_WORKTREE_TOOL_NAME,
      description: EXIT_DESCRIPTION,
      inputSchema: exitSchema,
      exclusive: true,
    },
    executionKey: () => "session-workspace",
    async run(rawInput): Promise<ToolRunResult> {
      const input = exitSchema.parse(rawInput) as ExitWorktreeInput;
      try {
        const info = await host.exit(input);
        return { output: `Left the worktree. The session is back in ${info.path}.` };
      } catch (err) {
        return { output: `${EXIT_WORKTREE_TOOL_NAME} failed: ${message(err)}`, isError: true };
      }
    },
  };
}

export function createWorktreeTools(host: WorktreeHost): ToolHandler[] {
  return [createEnterWorktreeTool(host), createExitWorktreeTool(host)];
}

/**
 * When to isolate, and the two commands that must not be emulated with a shell.
 * Names only tools that survived the host's denylist.
 */
export const WORKTREE_PROMPT: ToolPromptSection = {
  id: "worktree",
  order: 60,
  requiresAny: [ENTER_WORKTREE_TOOL_NAME, EXIT_WORKTREE_TOOL_NAME],
  render: (ctx) => {
    const enter = ctx.present.has(ENTER_WORKTREE_TOOL_NAME);
    const exit = ctx.present.has(EXIT_WORKTREE_TOOL_NAME);
    const lines: string[] = [];
    if (enter) {
      lines.push(
        `- Worktrees: use ${presentList(ctx, [ENTER_WORKTREE_TOOL_NAME])} when the user asks to work in a separate checkout, isolate a side task, or run an experiment without touching the current working tree. It moves the WHOLE session (tool cwd, permissions, sandbox roots, system prompt), not just one command's directory.`,
      );
      lines.push(
        `- ${ENTER_WORKTREE_TOOL_NAME} takes either \`name\` (create or reuse, optionally with \`from\` a commit-ish) or \`path\` (enter an existing worktree of this repository). Do not run \`git worktree add\` yourself.`,
      );
      lines.push(
        "- A new worktree is a fresh checkout: dependencies are not installed, and gitignored files are copied only when listed in `.worktreeinclude`.",
      );
    }
    if (exit) {
      lines.push(
        `- Use ${presentList(ctx, [EXIT_WORKTREE_TOOL_NAME])} to return to the main checkout. While isolated, do not \`cd\` or redirect git at the main checkout — the worktree guard blocks it.`,
      );
    }
    if (lines.length > 0) {
      lines.push(
        `- Call ${presentList(ctx, [ENTER_WORKTREE_TOOL_NAME, EXIT_WORKTREE_TOOL_NAME])} by itself in a model response: a workspace switch is exclusive, so any sibling tool call in the same response is deferred to the next response, after the session has moved.`,
      );
    }
    return lines.join("\n");
  },
};
