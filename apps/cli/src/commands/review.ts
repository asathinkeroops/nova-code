import type { SlashOutcome } from "@nova/external";

/**
 * `/review [focus]` — review the current uncommitted diff. Returns a prompt that
 * directs the main agent to inspect the working tree with its own tools and
 * report concrete, file-and-line findings rather than starting any edits.
 *
 * Any args narrow the focus (a subsystem, a class of bug, "security", etc.);
 * absent that, it reviews for correctness and regressions in adjacent code.
 *
 * Pure: depends only on the args string, so it lives outside CliContext.
 */
export function handleReview(args: string): SlashOutcome {
  const focus = args.trim() || "correctness and regressions in adjacent code";

  const text =
    "Review the repository's uncommitted changes. Do NOT edit anything — this " +
    "is a review only.\n\n" +
    "1. Run `git status` and `git diff` (include `git diff --staged`) to see " +
    "every pending change.\n" +
    `2. Review them with a focus on ${focus}. Flag anything risky, surprising, ` +
    "broken, or inconsistent with the surrounding code and conventions. Note " +
    "missing tests or edge cases where they matter.\n" +
    "3. Be concrete — reference file paths and line numbers, group findings by " +
    "severity, and skip praise and restating the obvious. If the diff looks " +
    "clean, say so plainly.\n\n" +
    "Write your review in the same language and script as this request.";

  return { kind: "prompt", text };
}
