import type { SlashOutcome } from "@nova/base";

const DEFAULT_FOCUS = "correctness and regressions in adjacent code";

/**
 * A leading pull-request reference: a bare or `#`-prefixed number, or a GitHub
 * pull-request URL. Anything else (a subsystem, "security", …) is a focus for
 * the local-diff review, so the numeric shape is what routes to PR mode.
 */
const PR_REF_RE = /^(?:#?(\d+)|https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+))\b\s*/;

/**
 * `/review [focus]` — review the current uncommitted diff (read-only).
 * `/review <PR#|#PR|github-pr-url> [focus]` — review an existing GitHub pull
 * request (read-only) via the `gh` CLI.
 *
 * Both forms return a prompt that directs the main agent to inspect with its own
 * tools and report concrete file-and-line findings — never to start edits or
 * post comments. A leading PR reference switches to PR mode and the remaining
 * args narrow the focus; otherwise all args are the focus and the review targets
 * the working tree.
 *
 * Pure: depends only on the args string, so it lives outside CliContext.
 */
export function handleReview(args: string): SlashOutcome {
  const trimmed = args.trim();

  const pr = trimmed.match(PR_REF_RE);
  if (pr) {
    const number = pr[1] ?? pr[2] ?? "";
    const focus = trimmed.slice(pr[0].length).trim() || DEFAULT_FOCUS;
    return { kind: "prompt", text: prReviewText(number, focus) };
  }

  const focus = trimmed || DEFAULT_FOCUS;
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

/** Prompt for reviewing an existing GitHub PR through the `gh` CLI. */
function prReviewText(pr: string, focus: string): string {
  return (
    `Review GitHub pull request #${pr}. Do NOT edit anything and do NOT post any ` +
    "comment to GitHub — this is a read-only review.\n\n" +
    `1. Fetch it with \`gh pr view ${pr}\` (title, description, checks) and ` +
    `\`gh pr diff ${pr}\` (the full diff). If \`gh\` is missing or not ` +
    "authenticated, say so and stop.\n" +
    `2. Review the diff with a focus on ${focus}. Flag anything risky, ` +
    "surprising, broken, or inconsistent with the surrounding code and " +
    "conventions. Note missing tests or edge cases where they matter.\n" +
    "3. Be concrete — reference file paths and line numbers, group findings by " +
    "severity, and skip praise and restating the obvious. If the diff looks " +
    "clean, say so plainly.\n\n" +
    "Write your review in the same language and script as this request."
  );
}
