import { extractText, type MessageParam, type ModelClient } from "@nova/core";

/**
 * Command-risk classification for the `auto` permission mode. Mirrors the
 * decision order of Claude Code's auto-mode classifier (static heuristics
 * first, model classifier for the rest):
 *
 *   1. static DENY rules  → known-destructive / exfiltration / privilege ops
 *   2. static ALLOW rules → clearly read-only single commands (fast-path)
 *   3. LLM classifier     → everything the rules can't decide
 *   4. fail-closed        → on no-model / timeout / parse failure, treat as risky
 *
 * A "risky" verdict does NOT hard-deny: the caller falls back to a confirmation
 * prompt (Claude Code's fallback-to-prompting behavior), so the user stays in
 * control while safe commands run unattended.
 *
 * NOT covered here (Claude Code does more): the server-side probe that scans
 * tool *results* for prompt-injection. This module classifies the outgoing
 * command only.
 */

export type StaticVerdict = "deny" | "allow" | "unknown";

export interface RiskVerdict {
  risk: "safe" | "risky";
  /** Short human-readable reason, surfaced in the fallback prompt. */
  reason?: string;
  /** Which layer decided — for logging/tests. */
  source: "rules" | "llm" | "fallback";
}

/**
 * High-signal destructive / exfiltration / privilege-escalation patterns,
 * matched against the whole command string (so they still fire inside a
 * `a && b` chain or a pipeline). Each entry pairs a regex with the reason shown
 * to the user. Conservative by design: a false "risky" only costs one prompt,
 * whereas a missed destructive command runs unattended.
 */
const DENY_RULES: ReadonlyArray<{ re: RegExp; reason: string }> = [
  // Recursive/forced filesystem deletion.
  { re: /\brm\s+(?:-[a-z]*\s+)*-[a-z]*r[a-z]*f|rm\s+(?:-[a-z]*\s+)*-[a-z]*f[a-z]*r/i, reason: "recursive/forced rm" },
  { re: /\brm\s+(?:-[a-z]*\s+)*-[a-z]*r\b/i, reason: "recursive rm" },
  { re: /\b(?:shred|wipe)\b/i, reason: "secure file destruction" },
  // Raw device / disk writes.
  { re: /\b(?:dd|mkfs\w*)\b/i, reason: "raw disk write / format" },
  { re: />\s*\/dev\/(?:sd|nvme|disk|hd)/i, reason: "write to a raw block device" },
  // Fork bomb.
  { re: /:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/, reason: "fork bomb" },
  // Download-and-execute (code exfiltration / arbitrary code exec).
  { re: /\b(?:curl|wget|fetch)\b[^|&;]*[|]\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, reason: "pipe a download straight into a shell" },
  { re: /\b(?:ba|z)?sh\b\s*<\s*\(\s*(?:curl|wget)/i, reason: "execute a downloaded script via process substitution" },
  { re: /\beval\s+["'`]?\$\(\s*(?:curl|wget)/i, reason: "eval the output of a network fetch" },
  // Privilege escalation.
  { re: /(?:^|[|&;]|\s)\s*(?:sudo|doas)\s+/i, reason: "privilege escalation (sudo/doas)" },
  { re: /(?:^|[|&;])\s*su\s+(?:-|\w)/i, reason: "switch user (su)" },
  // World-writable / recursive permission changes on broad targets.
  { re: /\bchmod\s+(?:-[a-zR]*\s+)*0?777\b/i, reason: "chmod 777" },
  { re: /\bchmod\s+-[a-z]*R[a-z]*\s/i, reason: "recursive chmod" },
  { re: /\bchown\s+-[a-z]*R[a-z]*\s/i, reason: "recursive chown" },
  // Writes into system locations.
  { re: /(?:>|\btee\b)\s*\/(?:etc|usr|bin|sbin|boot|sys|System)\b/i, reason: "write into a system directory" },
  // Dangerous git operations (history-rewriting / unrecoverable).
  { re: /\bgit\s+push\b[^|&;]*(?:--force(?:-with-lease)?|\s-f\b)/i, reason: "git force push" },
  { re: /\bgit\s+push\b[^|&;]*\b(?:origin\s+)?(?:main|master)\b/i, reason: "direct git push to main/master" },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard (discards work)" },
  { re: /\bgit\s+checkout\s+--\s+\./i, reason: "git checkout -- . (discards work)" },
  { re: /\bgit\s+restore\s+\.(?:\s|$)/i, reason: "git restore . (discards work)" },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, reason: "git clean -f (deletes untracked files)" },
  { re: /\bgit\s+stash\s+(?:drop|clear)\b/i, reason: "git stash drop/clear (loses stashed work)" },
  { re: /\bgit\s+commit\b[^|&;]*--amend\b/i, reason: "git commit --amend (rewrites history)" },
  // Irreversible GitHub (gh) operations — merging or deleting.
  { re: /\bgh\s+pr\s+merge\b/i, reason: "gh pr merge (merges a pull request)" },
  { re: /\bgh\s+repo\s+delete\b/i, reason: "gh repo delete" },
  // Infrastructure-as-code teardown.
  { re: /\b(?:terraform|terragrunt|pulumi|cdk|cdktf)\s+destroy\b/i, reason: "infrastructure destroy" },
  // Mass cloud deletion.
  { re: /\baws\s+s3\s+(?:rb|rm)\b[^|&;]*--recursive/i, reason: "recursive S3 deletion" },
  { re: /\bkubectl\s+delete\b[^|&;]*(?:--all\b|\bnamespace\b)/i, reason: "broad kubectl delete" },
];

/**
 * First tokens that mark a *clearly* read-only command, eligible for the
 * static allow fast-path (skips the LLM call). Only honored for a "simple"
 * command — no chaining, pipes, subshells, or redirection — so a benign-looking
 * leading token can't smuggle a destructive tail past us (e.g. `cat x && rm`),
 * which the DENY scan would already catch anyway.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "pwd", "echo", "cat", "head", "tail", "wc", "which", "whoami", "id",
  "date", "env", "printenv", "uname", "hostname", "true", "false",
  "grep", "rg", "ag", "fd", "find", "tree", "stat", "file", "du", "df",
  "node", "python", "python3", "tsc", "jq", "sort", "uniq", "cut", "diff",
]);

/**
 * Read-only `git` subcommands, fast-pathed even though `git` itself isn't in
 * READ_ONLY_COMMANDS (it also fronts mutating verbs like merge/rebase/commit).
 * Destructive git is already caught by DENY_RULES, so anything not listed here
 * just falls to the LLM classifier.
 */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "branch", "remote", "describe", "blame",
  "rev-parse", "ls-files", "ls-remote", "shortlog", "tag", "config",
]);

/**
 * Read-only `gh` (GitHub CLI) command signatures — the "<sub> <action>" pair —
 * fast-pathed for `auto` mode so PR/issue inspection runs unattended. Mutating
 * gh verbs (create/edit/close/comment) and `gh api` (can POST) are deliberately
 * absent: they fall to the LLM classifier. Irreversible ones (merge, repo
 * delete) are hard-caught by DENY_RULES above.
 */
const READ_ONLY_GH_SIGNATURES: ReadonlySet<string> = new Set([
  "pr view", "pr diff", "pr list", "pr checks", "pr status",
  "issue view", "issue list", "repo view", "run view", "run list",
]);

/** Shell metacharacters that make a command "not simple" (so no allow fast-path). */
const COMPOUND_RE = /[|&;<>`]|\$\(|\bxargs\b|\beval\b|\bexec\b/;

/**
 * Tokens of a command with any leading `VAR=val` env assignments and common
 * wrappers (`timeout 5s`, `env`, `nice`…) stripped, so [0] is the real verb and
 * [1] is its first argument/subcommand.
 */
function effectiveTokens(command: string): string[] {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++;
  while (i < tokens.length && /^(?:timeout|nice|nohup|time|command|env)$/.test(tokens[i] ?? "")) {
    // `timeout 5s cmd` / `env cmd` — skip the wrapper and its non-command args.
    i++;
    while (i < tokens.length && /^-|^\d/.test(tokens[i] ?? "")) i++;
  }
  return tokens.slice(i);
}

/** Pure, synchronous heuristic pass. Never calls the model. */
export function classifyCommandStatic(command: string): StaticVerdict {
  const cmd = command.trim();
  if (!cmd) return "allow"; // empty/no-op
  for (const { re } of DENY_RULES) {
    if (re.test(cmd)) return "deny";
  }
  if (!COMPOUND_RE.test(cmd)) {
    const [verb, sub, action] = effectiveTokens(cmd);
    if (verb && READ_ONLY_COMMANDS.has(verb)) return "allow";
    if (verb === "git" && sub && READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return "allow";
    if (verb === "gh" && sub && action && READ_ONLY_GH_SIGNATURES.has(`${sub} ${action}`)) return "allow";
  }
  return "unknown";
}

/** Reason string attached to a static "deny", for the fallback prompt. */
function denyReason(command: string): string {
  for (const { re, reason } of DENY_RULES) {
    if (re.test(command)) return reason;
  }
  return "matched a destructive-command rule";
}

const CLASSIFIER_SYSTEM =
  "You are a command-safety classifier for an autonomous coding agent's `auto` mode. " +
  "You are given a single shell command the agent wants to run unattended in the user's workspace. " +
  "Decide whether it is SAFE to run without human confirmation, or RISKY (must ask the user first).\n\n" +
  "Treat as RISKY: deleting or overwriting files that likely predate this session; downloading and executing code " +
  "(curl|bash and friends); sending workspace data, secrets, or credentials to external endpoints; privilege escalation " +
  "(sudo/su); production deploys, database migrations, or mass deletion of cloud/storage resources; IAM or repo-permission " +
  "changes; history-rewriting or destructive git (force push, push to main, reset --hard, clean -fd); and infrastructure " +
  "teardown (terraform/pulumi/cdk destroy).\n" +
  "Treat as SAFE: read-only inspection, builds, tests, linters, formatters, installing already-declared dependencies, " +
  "local file edits inside the workspace, and pushing to a non-main feature branch.\n\n" +
  'Respond with ONLY a compact JSON object: {"risk":"safe"|"risky","reason":"<short>"}. No prose, no code fences.';

/** Parse the classifier's JSON reply defensively. Returns null if unusable. */
function parseClassifierReply(raw: string): RiskVerdict | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { risk?: unknown; reason?: unknown };
    if (obj.risk !== "safe" && obj.risk !== "risky") return null;
    return {
      risk: obj.risk,
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
      source: "llm",
    };
  } catch {
    return null;
  }
}

export interface ClassifyOptions {
  /** LLM classifier. Omit to run rules-only (undecided commands → risky). */
  model?: ModelClient;
  /** Abort the model call after this many ms; on timeout the command is risky. */
  timeoutMs?: number;
  /** Outer cancellation (e.g. user interrupt). */
  signal?: AbortSignal;
}

/**
 * Classify a command for `auto` mode. Static rules decide first; only the
 * genuinely-undecided commands reach the model. Fail-closed: any model
 * absence, timeout, or parse failure yields "risky" so the caller prompts.
 */
export async function classifyCommandRisk(
  command: string,
  opts: ClassifyOptions = {},
): Promise<RiskVerdict> {
  const stat = classifyCommandStatic(command);
  if (stat === "deny") return { risk: "risky", reason: denyReason(command), source: "rules" };
  if (stat === "allow") return { risk: "safe", source: "rules" };

  if (!opts.model) {
    return { risk: "risky", reason: "no classifier available; command not recognized as safe", source: "fallback" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  const onOuterAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const messages: MessageParam[] = [{ role: "user", content: `Command:\n${command}` }];
    const result = await opts.model.call({
      system: CLASSIFIER_SYSTEM,
      messages,
      tools: [],
      maxTokens: 256,
      thinkingBudgetTokens: 0,
      signal: controller.signal,
    });
    const parsed = parseClassifierReply(extractText(result.content).trim());
    if (parsed) return parsed;
    return { risk: "risky", reason: "classifier returned an unparseable verdict", source: "fallback" };
  } catch (err) {
    const reason = controller.signal.aborted ? "classifier timed out" : err instanceof Error ? err.message : String(err);
    return { risk: "risky", reason, source: "fallback" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}
