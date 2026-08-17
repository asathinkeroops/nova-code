/**
 * Shared expansion stages for authored prompt text — slash-command `.md`
 * bodies and `SKILL.md` bodies alike.
 *
 * These live in `@nova/base` rather than `@nova/core` because they touch the
 * filesystem and spawn subprocesses, and `core` is deliberately free of
 * `node:*` imports. Both consumers (`apps/cli`'s slash-command loader, and
 * `@nova/tools` for skills) already depend on base, so this is the one place
 * both can reach without inverting the dependency graph.
 *
 * Every stage is independently callable: the two consumers compose different
 * subsets in different orders, and neither should have to accept the other's
 * stages to get the ones it wants.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Execute a shell command for `` !`cmd` `` interpolation. Injected by the host
 * so execution stays sandbox-confined and these leaf helpers keep no dependency
 * on the tool/sandbox layer.
 */
export type PromptCommandRunner = (
  command: string,
) => Promise<{ output: string; isError: boolean }>;

/** `` !`cmd` `` shell interpolation. */
const BANG_RE = /!`([^`]+)`/g;
/** `@path` file reference at a word boundary (so emails / `@scope/pkg` are safe). */
const MENTION_RE = /(^|\s)@([^\s]+)/g;
/** `${NAME}` variable reference. Uppercase-only, so `${foo}` in prose is untouched. */
const VAR_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;
/** Cap embedded file content so a stray `@huge.log` can't blow up the prompt. */
const MAX_EMBED_BYTES = 100_000;

export const SHELL_DISABLED_NOTICE = "[shell command execution disabled by settings]";

/** Replace matches of a global regex with an async-computed replacement. */
async function replaceAsync(
  input: string,
  re: RegExp,
  fn: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  re.lastIndex = 0;
  const hits: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    hits.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  let out = "";
  let last = 0;
  for (const hit of hits) {
    out += input.slice(last, hit.index);
    out += await fn(hit[0], ...hit.slice(1));
    last = hit.index + hit[0].length;
  }
  return out + input.slice(last);
}

/**
 * Substitute `${NAME}` references from `vars`. A name that isn't in the map is
 * left verbatim rather than blanked — prose that happens to contain `${FOO}`
 * should survive, and a silently emptied path is far worse than a visible one.
 */
export function expandVars(body: string, vars: Readonly<Record<string, string>>): string {
  return body.replace(VAR_RE, (match, name: string) => vars[name] ?? match);
}

/**
 * Placeholder for an escaped `\$` while substitution runs, restored to a bare
 * `$` at the end. U+FFFF is a permanent noncharacter, so it cannot occur in
 * meaningful input.
 */
const ESCAPE_SENTINEL = "￿";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ExpandArgsOptions {
  /**
   * Values for named `$name` references. Callers that also run a `{{name}}`
   * layer should pass the *same* resolved map, so `{{path}}` and `$path` in one
   * file can never disagree.
   */
  named?: Readonly<Record<string, string>>;
}

export interface ExpandArgsResult {
  text: string;
  /** True if any placeholder actually consumed an argument. */
  bound: boolean;
}

/**
 * Substitute argument references:
 *   - `$ARGUMENTS` — the whole trimmed argument string
 *   - `$ARGUMENTS[n]` — the n-th token, **0-indexed** (Claude Code spelling)
 *   - `$1`..`$N` — positional tokens, **1-indexed** (nova's long-standing
 *     spelling; `$1` is the first argument)
 *   - `$name` — a declared named argument, from `opts.named`
 *   - `\$` — an escaped dollar, emitted literally and never substituted
 *
 * Out-of-range positionals and indexes expand to empty, so a template never
 * leaks a raw `$2` into the prompt when the user supplied one argument — but
 * they do not set `bound`, which reports only whether a reference actually
 * consumed one of the supplied arguments.
 */
export function expandArgs(
  body: string,
  rawArgs: string,
  opts: ExpandArgsOptions = {},
): ExpandArgsResult {
  const trimmed = rawArgs.trim();
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  const named = opts.named ?? {};
  // Longest name first so `$foo` cannot shadow `$foobar`.
  const names = Object.keys(named).sort((a, b) => b.length - a.length);

  // Protect `\$` before anything else, but only where a substitution would
  // otherwise have happened — a lone `\$5.00` in prose keeps its backslash.
  const substitutable = ["\\d", "ARGUMENTS", ...names.map((n) => `${escapeRegExp(n)}(?![[\\w])`)];
  let text = body.replace(
    new RegExp(`(?<!\\\\)\\\\\\$(?=${substitutable.join("|")})`, "g"),
    ESCAPE_SENTINEL,
  );

  let bound = false;
  /**
   * Substitute `value`, reporting `bound` only when something was actually
   * consumed. A reference that resolves to nothing — an out-of-range `$2`, an
   * `$ARGUMENTS[5]` past the end, a declared arg the user left unset — expands
   * to empty but must NOT count as bound: it did not carry the user's input
   * into the prompt, so the caller's `ARGUMENTS:` fallback still has to fire.
   * Marking it bound is how typed arguments used to vanish entirely (`Fix $2`
   * with one argument produced `Fix ` and nothing else).
   */
  const take = (value: string | undefined): string => {
    if (value === undefined || value === "") return "";
    bound = true;
    return value;
  };

  for (const name of names) {
    text = text.replace(new RegExp(`\\$${escapeRegExp(name)}(?![[\\w])`, "g"), () =>
      take(named[name]),
    );
  }
  text = text.replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, n: string) => take(tokens[Number(n)]));
  text = text.replace(/\$(\d+)(?!\w)/g, (_m, n: string) => take(tokens[Number(n) - 1]));
  text = text.replaceAll("$ARGUMENTS", () => take(trimmed));

  return { text: text.replaceAll(ESCAPE_SENTINEL, "$"), bound };
}

/** {@link expandArgs}, returning just the text. */
export function expandDollarArgs(
  body: string,
  rawArgs: string,
  opts?: ExpandArgsOptions,
): string {
  return expandArgs(body, rawArgs, opts).text;
}

/**
 * Embed the contents of `@path` references, resolved against `cwd`. A path that
 * doesn't resolve to a readable file is left verbatim, which is what keeps
 * emails and `@scope/pkg` in prose intact.
 */
export async function expandMentions(body: string, cwd: string): Promise<string> {
  return replaceAsync(body, MENTION_RE, async (full, lead: string, rel: string) => {
    const abs = resolve(cwd, rel);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return full;
    let content = await readFile(abs, "utf8").catch(() => null);
    if (content === null) return full;
    let note = "";
    if (Buffer.byteLength(content, "utf8") > MAX_EMBED_BYTES) {
      content = content.slice(0, MAX_EMBED_BYTES);
      note = "\n… (truncated)";
    }
    return `${lead}Contents of ${rel}:\n\`\`\`\n${content}${note}\n\`\`\``;
  });
}

export interface ExpandShellOptions {
  /** Absent → `` !`cmd` `` segments are left verbatim. */
  runCommand?: PromptCommandRunner;
  /**
   * When true, `` !`cmd` `` segments are replaced with a visible notice instead
   * of being executed. Distinct from an absent runner: this states that
   * execution was refused, rather than leaving text that looks unprocessed.
   */
  disabled?: boolean;
}

/** Run `` !`cmd` `` segments and inline their output. */
export async function expandShell(body: string, opts: ExpandShellOptions): Promise<string> {
  if (opts.disabled) return body.replace(BANG_RE, () => SHELL_DISABLED_NOTICE);
  const runCommand = opts.runCommand;
  if (!runCommand) return body;
  return replaceAsync(body, BANG_RE, async (_full, command: string) => {
    const { output } = await runCommand(command);
    return output.trim();
  });
}
