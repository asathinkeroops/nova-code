import type { SlashOutcome } from "@nova/external";

/**
 * `/commit [guidance]` — review the pending changes and create a git commit.
 * Returns a prompt that directs the main agent to inspect the working tree with
 * its own tools, stage the changes that belong together, write a Conventional
 * Commits message, and commit (never push).
 *
 * Any args are passed through as extra guidance (scope to focus on, files to
 * leave out, a message hint, etc.).
 *
 * Pure: depends only on the args string, so it lives outside CliContext.
 */
export function handleCommit(args: string): SlashOutcome {
  const guidance = args.trim();
  const guidanceLine = guidance
    ? `\n\nExtra guidance from me: ${guidance}`
    : "";

  const text =
    "Review the repository's pending changes and create a git commit. Steps:\n\n" +
    "1. Run `git status` and `git diff` (and `git diff --staged` if anything is " +
    "already staged) to understand what changed and why.\n" +
    "2. Run `git log -n 10` to study the repo's existing commit conventions — " +
    "match its language (e.g. if recent messages are in Chinese, write in " +
    "Chinese), its subject style and prefixes, and whether it uses bodies.\n" +
    "3. Stage the changes that belong together for this commit with `git add`. " +
    "Leave out unrelated edits, generated files, and anything that looks " +
    "accidental — call out what you skipped.\n" +
    "4. Write the commit message. Default to the Conventional Commits style " +
    "(`type(scope): summary` — feat|fix|refactor|docs|test|chore|perf, " +
    "imperative subject ≤72 chars, a short body explaining the *why* when the " +
    "change is non-trivial), but defer to the repo's own convention from step 2 " +
    "where it differs.\n" +
    "5. Create the commit. Do NOT push, and do NOT add co-author or tool " +
    "attribution trailers unless I ask.\n" +
    "6. Briefly tell me the commit subject and what you staged." +
    guidanceLine;

  return { kind: "prompt", text };
}
