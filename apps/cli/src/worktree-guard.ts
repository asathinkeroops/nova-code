import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, basename } from "node:path";
import { canonicalizePathSync } from "@nova/base";
import { isWithin } from "@nova/safety";

/**
 * Worktree isolation checks.
 *
 * Once a session works inside a linked worktree, the main checkout is one
 * directory away and shares the same object database — so an ordinary tool call
 * can quietly mutate it. These checks are the enforcement half of that
 * boundary; the prompt half is the `<worktree>` block (see `@nova/agent`).
 *
 * The rules mirror Claude Code's, which are worth restating because the last
 * one is deliberately conservative:
 *
 * 1. A file-mutating tool targeting the main checkout is refused.
 * 2. A command tool whose working directory resolves there is refused.
 * 3. A command that redirects git at it — `-C`, `--git-dir`, `--work-tree`, or
 *    the `GIT_*` redirect family in the text OR in the tool's `env` — is
 *    refused. The same rule applies when the binding is made by a wrapper
 *    (`env GIT_DIR=… git …`): the assignment is handed to the child command's
 *    check instead of being dropped with the wrapper. `GIT_DIR`-shaped
 *    variables are judged by a different rule than `GIT_WORK_TREE`: see
 *    `isProtectedGitState` (the shared git dir holds the main checkout's
 *    HEAD/index, while its `objects/` and each checkout's own
 *    `worktrees/<name>` are legitimate).
 * 4. A `cd` into it anywhere in the command is refused.
 * 5. A command that mentions git but hides part of itself in a dynamic
 *    expansion (`$(…)`, backticks, `${!x}`, process substitution) is refused —
 *    the text cannot prove the git it runs stays inside the worktree.
 *
 * Relative paths in the command text resolve against the directory the command
 * ACTUALLY runs in — after canonicalizing BOTH sides, so a symlink into the
 * main checkout is judged by its target (and a symlink back into the worktree
 * is not mistaken for the main checkout). Canonicalization follows the OS
 * traversal the tool will follow: components are resolved left to right, so a
 * `..` after a symlink is the parent of the LINK'S TARGET (`link/..`), never a
 * lexical fold of the literal path — see `canonicalizePathSync`.
 *
 * That directory is not one value: it is the set of directories the command
 * might be in, because a shell does not execute a flat list of words. `(cd x)`
 * and `cd x | …` run in subshells, so the `cd` does not survive; `a && cd x`
 * and `a || cd x` may not run at all; `cd` into a missing directory fails and
 * leaves the shell where it was. `env -C`, `pushd`/`popd`, and a nested
 * `sh -c '…'` / `eval '…'` move or re-run the shell too. A target that is
 * protected in ANY of those possible directories is refused, because the shell
 * could take that branch — this is what stops `(cd sub); git -C ..` from being
 * judged as if the outer shell had moved. Command substitution is still not
 * evaluated: it is covered by rule 5 instead.
 *
 * What this does NOT do, by design: track which files a shell command writes.
 * `cp ../main-repo/x .` still behaves like any other shell command and is left
 * to the permission gate and the OS sandbox. The checks read the edit target,
 * the command's working directory, and its text.
 */

/** Tools whose `path` input names a file they are about to mutate. */
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * Tools that spawn a shell and take an optional `cwd`. Exported (and used by
 * the permission gate) so "which tools carry a cwd" has exactly one definition.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "monitor"]);

/**
 * Environment variables that make git operate somewhere other than the checkout
 * the shell is in. `GIT_DIR` / `GIT_WORK_TREE` are the classic pair; the rest
 * move the index, the object store or the config just as effectively, and a
 * tool that forwards `env` hands all of them to git.
 *
 * Which rule they must satisfy depends on what they name — `GIT_STATE_ENV`
 * below splits them into "git state" (`GIT_DIR` and friends) and "working
 * tree" (`GIT_WORK_TREE`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`).
 */
const GIT_REDIRECT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
] as const;

export interface WorktreeGuardInput {
  /**
   * The main checkout, when git metadata can name it. Absent in the
   * `--separate-git-dir` + linked-worktree layout — `gitDir` then decides.
   */
  main?: string;
  /** The repository's shared git dir (`git rev-parse --git-common-dir`). */
  gitDir?: string;
  /** The checkout the session works in; the fallback base for relative paths. */
  workspace: string;
  /**
   * The repository's other checkouts. Worktrees normally live inside the repo
   * root, so these are subtracted from "inside the main checkout" — otherwise
   * every write into the worktree itself would be flagged.
   */
  checkouts?: readonly string[];
  tool: string;
  input: Record<string, unknown>;
  /** Canonical absolute target of a path-bearing tool, when the gate resolved one. */
  path?: string | undefined;
}

export interface WorktreeGuardDenial {
  reason: string;
}

function within(root: string, candidate: string): boolean {
  return resolve(root) === candidate || isWithin(root, candidate);
}

interface Scope {
  main?: string;
  gitDir?: string;
  workspace: string;
  checkouts: readonly string[];
}

/**
 * The git dir of the checkout containing `abs`, found by walking up to its
 * `.git` entry. Pure filesystem work (no git subprocess): the guard runs on
 * every tool call.
 *
 * Both ends are canonicalized: a symlinked directory (or a symlinked `.git`)
 * must be classified by the checkout it really lands in, not by where its name
 * says it lives.
 */
function checkoutGitDir(abs: string): string | undefined {
  let dir = canonicalizePathSync("/", abs);
  for (;;) {
    const entry = join(dir, ".git");
    try {
      const st = statSync(entry);
      if (st.isDirectory()) return canonicalizePathSync("/", entry);
      if (st.isFile()) {
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(entry, "utf8"));
        if (match?.[1]) return canonicalizePathSync(dir, match[1].trim());
      }
    } catch {
      // No `.git` here (or unreadable) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Would operating on this ABSOLUTE path reach a checkout the session must not
 * touch?
 *
 * With a known main checkout it is the plain containment rule (worktrees live
 * under the repo root, so they are subtracted). Without one — a separate git dir
 * plus a linked worktree — the target is CLASSIFIED instead: walk up to its
 * `.git` and compare. A git dir equal to ours means "a main working tree of this
 * repository" (exactly the directory we could not name up front), a git dir under
 * `<common>/worktrees/…` is a sibling checkout, and anything else belongs to
 * another repository and is none of our business.
 */
function isProtected(scope: Scope, abs: string): boolean {
  if (scope.main) {
    if (!within(scope.main, abs)) return false;
    return !scope.checkouts.some((checkout) => within(checkout, abs));
  }
  if (!scope.gitDir) return false;
  const gitdir = checkoutGitDir(abs);
  if (!gitdir) return false;
  const common = resolve(scope.gitDir);
  // Only the main working trees of THIS repository point straight at our shared
  // git dir. A sibling worktree points at `<common>/worktrees/<name>`, and any
  // other repository has its own git dir — both are none of our business.
  if (gitdir === common) return true;
  return false;
}

/**
 * Would naming this path as a *git directory* (or index) reach the MAIN
 * checkout's private git state?
 *
 * This is deliberately separate from {@link isProtected}, which answers the
 * working-tree question. A linked worktree shares `<common>/objects` (content
 * addressed — writing there is what a normal commit does) and owns
 * `<common>/worktrees/<name>` (its HEAD and index), but the common dir ITSELF
 * holds the main checkout's `HEAD`, `index`, `config`, `hooks`, `refs` and
 * `logs`. Pointing `GIT_DIR` at it makes git stage into the main index while
 * the command still looks "inside the worktree" — verified against a real
 * `--separate-git-dir` repository: `GIT_DIR=<common> git add x` staged x in
 * the main checkout. So the exclusion list is narrow, and everything else in
 * the common dir stays protected.
 *
 * A path that IS a checkout's `.git` entry (`<main>/.git`, a `gitdir:` file) is
 * resolved to the git dir it names first — that is the same state by another
 * name, and the existing test suite sends exactly that shape.
 */
function isProtectedGitState(scope: Scope, abs: string): boolean {
  const common = scope.gitDir;
  if (!common) return isProtected(scope, abs);
  const target = gitEntryTarget(abs);
  // The shared object store and each checkout's own per-worktree state are the
  // two parts of the common dir a worktree legitimately touches.
  if (within(join(common, "objects"), target)) return false;
  if (within(join(common, "worktrees"), target)) return false;
  return within(common, target);
}

/** Resolve a checkout's `.git` entry (directory, or `gitdir:` file) to its git dir. */
function gitEntryTarget(abs: string): string {
  if (basename(abs) !== ".git") return abs;
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return canonicalizePathSync("/", abs);
    if (st.isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(abs, "utf8"));
      if (match?.[1]) return canonicalizePathSync(dirname(abs), match[1].trim());
    }
  } catch {
    // Not an existing `.git` entry — treat the path as given.
  }
  return abs;
}

/**
 * Which rule a `GIT_*` redirect must satisfy. `GIT_DIR`-shaped variables name
 * git STATE, so the main checkout's index/HEAD must be refused even when the
 * path is not in its working tree; `GIT_WORK_TREE` names a working tree, so the
 * ordinary containment rule is the right one.
 */
const GIT_STATE_ENV: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
]);

function isProtectedRedirect(scope: Scope, name: string, abs: string): boolean {
  return GIT_STATE_ENV.has(name) ? isProtectedGitState(scope, abs) : isProtected(scope, abs);
}

/** How to name the protected checkout in a denial message. */
function protectedLabel(scope: Scope, abs: string): string {
  return scope.main
    ? `the main checkout (${scope.main})`
    : `another checkout of this repository (${abs})`;
}

/** A token whose value cannot be known without running the shell. */
function isUnresolvable(token: string): boolean {
  return (
    token.startsWith("$") ||
    token.startsWith("~") ||
    token.includes("$(") ||
    token.includes("`") ||
    token.includes("${")
  );
}

/** Operators a shell program is split on. `op` is what precedes `text`. */
export type ShellOp = "start" | ";" | "\n" | "&&" | "||" | "|" | "&" | "(" | ")" | "{" | "}";

export interface ShellPart {
  op: ShellOp;
  text: string;
}

/**
 * Split a shell command into simple commands WITHOUT throwing away the operator
 * that separates them.
 *
 * The operator is the whole point: `cd x; git …` and `cd x && git …` differ in
 * whether git runs after a failed `cd`, `(cd x); git …` differs in whether the
 * `cd` survives the subshell, and `cd x | cat` differs in whether it survives
 * the pipeline at all. Flattening them into a bare list (the previous
 * `splitShellCommands`) made every `cd` look unconditional and shell-wide, so
 * `(cd sub); git -C .. rev-parse` was judged as if the outer shell had moved —
 * git really ran from the original directory and could reach the main checkout.
 *
 * Quoted text, `$(…)`, `${…}`, `<(…)` and arithmetic `((…))` are kept intact:
 * they are dynamic (and refused elsewhere) or irrelevant, but splitting inside
 * them would invent commands that never run.
 */
export function splitShellProgram(command: string): ShellPart[] {
  const parts: ShellPart[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let pending: ShellOp = "start";

  const emit = (op: ShellOp): void => {
    const text = current.trim();
    current = "";
    if (text.length > 0) parts.push({ op: pending, text });
    pending = op;
  };

  /** Index just past the bracket matching the one at `open`. */
  const skipBalanced = (open: number, closer: ")" | "}"): number => {
    let depth = 0;
    let inner: '"' | "'" | null = null;
    for (let i = open; i < command.length; i++) {
      const ch = command[i] as string;
      if (inner) {
        if (ch === inner) inner = null;
        else if (ch === "\\" && inner === '"') i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inner = ch;
        continue;
      }
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "(" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "}") {
        depth -= 1;
        if (depth === 0 && ch === closer) return i + 1;
      }
    }
    return command.length;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') current += command[++i] ?? "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      current += ch + (command[++i] ?? "");
      continue;
    }
    // Keep `$(…)`, `${…}`, `<(…)`, `>(…)` and `((…))` in one piece.
    const prev = command[i - 1];
    const next = command[i + 1];
    if (ch === "$" && next === "(") {
      const end = skipBalanced(i + 1, ")");
      current += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === "$" && next === "{") {
      const end = skipBalanced(i + 1, "}");
      current += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      const end = skipBalanced(i + 1, ")");
      current += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === "(" && next === "(") {
      const end = skipBalanced(i, ")");
      current += command.slice(i, end);
      i = end - 1;
      continue;
    }
    // `&` is only an operator when it is not part of a redirection.
    if (ch === "&") {
      if (prev === ">" || prev === "<" || next === ">") {
        current += ch;
        continue;
      }
      if (next === "&") {
        emit("&&");
        i += 1;
        continue;
      }
      emit("&");
      continue;
    }
    if (ch === "|") {
      if (next === "|") {
        emit("||");
        i += 1;
        continue;
      }
      if (next === "&") {
        // `|&` pipes stderr too — still a pipeline.
        emit("|");
        i += 1;
        continue;
      }
      emit("|");
      continue;
    }
    if (ch === ";") {
      emit(";");
      continue;
    }
    if (ch === "\n") {
      emit("\n");
      continue;
    }
    if (ch === ")") {
      // The closing paren is its own part: the walker must restore the enclosing
      // scope even when no text follows it (`(cd sub); git …`).
      emit(")");
      parts.push({ op: ")", text: "" });
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "}") {
      emit(ch as ShellOp);
      continue;
    }
    current += ch;
  }
  emit(";");
  return parts;
}

/** Split one simple command into words, honouring quotes (no expansion). */
export function tokenizeCommand(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') current += segment[++i] ?? "";
      else current += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\") {
      current += segment[++i] ?? "";
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) tokens.push(current);
      current = "";
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (has) tokens.push(current);
  return tokens;
}

/** Shell keywords that can prefix a simple command (`then cd x`, `do cd x`). */
const LEADING_KEYWORDS = new Set([
  "then",
  "do",
  "else",
  "if",
  "elif",
  "while",
  "until",
  "!",
  "{",
  "(",
]);

function withoutKeywords(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && LEADING_KEYWORDS.has(tokens[i] as string)) i += 1;
  return tokens.slice(i);
}

/**
 * Resolve a path token against the current shell directory, to the REAL path.
 *
 * `path.resolve` alone is not enough: a symlink inside the worktree can point
 * at the main checkout, and a lexical answer would judge it as "still inside"
 * while git — which follows the link — lands in the main checkout. The reverse
 * also matters: a symlink in the main checkout that points back into the
 * worktree is a legitimate target and must not be refused. Both sides of every
 * comparison go through the same canonicalizer, so scope roots are normalized
 * once in `worktreeIsolationDenial`.
 */
function resolveAgainst(base: string | undefined, token: string): string | undefined {
  if (isUnresolvable(token)) return undefined;
  if (isAbsolute(token)) return canonicalizePathSync("/", token);
  return base === undefined ? undefined : canonicalizePathSync(base, token);
}

/**
 * One possible shell directory per execution path.
 *
 * `unknown` means the walk lost track (a dynamic `cd`, an unresolvable
 * `pushd`); relative targets are then unverifiable and refused whenever git is
 * in play. `dirs` holds every directory the shell might be in — `a && cd b`
 * leaves both branches possible — and a target is refused if ANY of them is
 * protected, because the shell could take that branch.
 */
interface CwdState {
  dirs: string[];
  unknown: boolean;
}

const MAX_CWD_CANDIDATES = 8;
const MAX_SHELL_NESTING = 4;
/** Interpreters whose `-c` argument is a shell script we must walk too. */
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Does `cd` into this path succeed? undefined when we cannot tell. */
function directoryExists(abs: string): boolean | undefined {
  try {
    return statSync(abs).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
  }
}

/**
 * Everything one command can do to move git: `cd`/`pushd`/`popd`, `env -C`,
 * `git -C`, the git redirect flags, inline `GIT_*=` assignments, and a nested
 * `sh -c '…'` / `eval '…'`. Walks the program in order while keeping shell
 * SCOPE (a `cd` inside `(…)` or on the left of a pipe does not survive) and
 * EXECUTION BRANCHES (`&&` / `||` may not run; a `cd` into a missing directory
 * fails and leaves the shell where it was).
 */
function commandDenial(opts: {
  scope: Scope;
  command: string;
  startCwd: string;
}): WorktreeGuardDenial | undefined {
  const { scope } = opts;
  const deny = (reason: string): WorktreeGuardDenial => ({ reason });
  const start: CwdState = { dirs: [canonicalizePathSync("/", opts.startCwd)], unknown: false };

  /** Resolve a token against every candidate directory of a state. */
  const resolveToken = (
    state: CwdState,
    token: string,
  ): { targets: string[]; unresolved: boolean } => {
    if (isUnresolvable(token)) return { targets: [], unresolved: true };
    if (isAbsolute(token))
      return { targets: [canonicalizePathSync("/", token)], unresolved: false };
    if (state.unknown || state.dirs.length === 0) return { targets: [], unresolved: true };
    return {
      targets: state.dirs.map((dir) => canonicalizePathSync(dir, token)),
      unresolved: false,
    };
  };

  /** Both branches of a conditional join. */
  const union = (a: CwdState, b: CwdState): CwdState => {
    const dirs = [...new Set([...a.dirs, ...b.dirs])];
    if (a.unknown || b.unknown || dirs.length > MAX_CWD_CANDIDATES) {
      return { dirs: [], unknown: true };
    }
    return { dirs, unknown: false };
  };

  const unverifiableCd = (target: string): WorktreeGuardDenial =>
    deny(
      `Blocked: the command \`cd\`s to "${target}", whose directory can't be verified, and ` +
        `then runs git — so it may operate on the main checkout. Use a literal path.`,
    );

  const cdInto = (abs: string): WorktreeGuardDenial =>
    deny(
      `Blocked: the command \`cd\`s into ${protectedLabel(scope, abs)}. ` +
        `This session's work belongs in the worktree (${opts.startCwd}).`,
    );

  type Step = { denial: WorktreeGuardDenial } | { denial?: undefined; state: CwdState };

  const walkTokens = (
    tokens: string[],
    state: CwdState,
    mentionsGit: boolean,
    depth: number,
    /**
     * `GIT_*=` assignments already applied to this command by an enclosing
     * `env` (or inherited from one). They no longer appear in `tokens`, so the
     * redirect check has to be handed them explicitly — dropping them is what
     * let `env GIT_DIR=<main>/.git git add …` through while the same command
     * without the `env` prefix was refused.
     */
    inheritedEnv: readonly string[] = [],
  ): Step => {
    if (tokens.length === 0) return { state };
    const head = tokens[0] as string;

    // ── directory changes ──────────────────────────────────────────────────
    if (head === "cd" || head === "pushd" || head === "popd") {
      // Skip `-L`/`-P`/`--` options; a bare `-` means $OLDPWD.
      const target = tokens.slice(1).find((token) => token === "-" || !token.startsWith("-"));
      if (head === "popd" || target === undefined || target === "-") {
        // $HOME / $OLDPWD / the pushd stack: no longer a known base.
        return { state: { dirs: [], unknown: true } };
      }
      const resolved = resolveToken(state, target);
      if (resolved.unresolved) {
        if (mentionsGit) return { denial: unverifiableCd(target) };
        return { state: { dirs: [], unknown: true } };
      }
      const hit = resolved.targets.find((abs) => isProtected(scope, abs));
      if (hit !== undefined) return { denial: cdInto(hit) };
      // A `cd` succeeds only where the directory really is one. When it fails
      // (the `cd missing || git …` case) the shell stays put — treating it as
      // success is what let the guard walk into the main checkout.
      const dirs: string[] = [];
      for (const [i, abs] of resolved.targets.entries()) {
        const exists = directoryExists(abs);
        if (exists === undefined) return { state: { dirs: [], unknown: true } };
        dirs.push(exists ? abs : (state.dirs[i] as string));
      }
      return { state: { dirs: [...new Set(dirs)], unknown: false } };
    }

    // ── `env -C … cmd` ─────────────────────────────────────────────────────
    if (basename(head) === "env") {
      let i = 1;
      let cwd = state;
      // `env -i` starts from an empty environment; everything else inherits.
      let carried: readonly string[] = inheritedEnv;
      const assignments: string[] = [];
      for (; i < tokens.length; i++) {
        const token = tokens[i] as string;
        if (token === "-i" || token === "--ignore-environment") {
          carried = [];
          continue;
        }
        if (token === "-0" || token === "--null") continue;
        if (token === "-u" || token === "--unset") {
          i += 1;
          continue;
        }
        if (token === "--") {
          // Everything after `--` is the command line.
          i += 1;
          break;
        }
        if (token.startsWith("--unset=") || (token.startsWith("-u") && token.length > 2)) continue;
        let value: string | undefined;
        if (token === "-C" || token === "--chdir") value = tokens[++i];
        else if (token.startsWith("--chdir=")) value = token.slice("--chdir=".length);
        else if (token.startsWith("-C") && token.length > 2) value = token.slice(2);
        if (value !== undefined) {
          const resolved = resolveToken(cwd, value);
          if (resolved.unresolved) {
            if (mentionsGit) return { denial: unverifiableCd(value) };
            cwd = { dirs: [], unknown: true };
            continue;
          }
          const hit = resolved.targets.find((abs) => isProtected(scope, abs));
          if (hit !== undefined) return { denial: cdInto(hit) };
          cwd = { dirs: resolved.targets, unknown: false };
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
          // Keep the assignment: it is part of the child's environment and must
          // go through the same `GIT_*` redirect check as an inline prefix.
          assignments.push(token);
          continue;
        }
        break;
      }
      if (i >= tokens.length) return { state };
      const child = walkTokens(tokens.slice(i), cwd, mentionsGit, depth, [
        ...carried,
        ...assignments,
      ]);
      // `env` starts a new process: a `cd` in it cannot move this shell.
      return child.denial ? child : { state };
    }

    // ── nested interpreters ────────────────────────────────────────────────
    if (SHELL_INTERPRETERS.has(basename(head))) {
      const flagAt = tokens.findIndex((token, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
      const script = flagAt === -1 ? undefined : tokens[flagAt + 1];
      if (script === undefined) return { state };
      const inner = walkProgram(splitShellProgram(script), state, depth + 1, inheritedEnv);
      // A subshell's `cd` is invisible to the caller.
      return inner.denial ? inner : { state };
    }

    if (head === "eval") {
      const script = tokens.slice(1).join(" ");
      if (!script) return { state };
      // `eval` runs in THIS shell, so its `cd` does persist.
      return walkProgram(splitShellProgram(script), state, depth + 1, inheritedEnv);
    }

    // ── git redirect flags ─────────────────────────────────────────────────
    const gitAt = tokens.findIndex((token) => basename(token) === "git");
    let gitCwd = state;
    if (gitAt !== -1) {
      // `git -C …` composes: each -C is relative to the previous one.
      for (let i = gitAt + 1; i < tokens.length; i++) {
        const token = tokens[i] as string;
        let value: string | undefined;
        let label = token;
        const isGitDir = token === "--git-dir" || token.startsWith("--git-dir=");
        if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
          value = tokens[++i];
          label = `${token} ${value ?? ""}`;
        } else if (token.startsWith("-C") && token.length > 2) {
          value = token.slice(2);
        } else if (token.startsWith("--git-dir=")) {
          value = token.slice("--git-dir=".length);
        } else if (token.startsWith("--work-tree=")) {
          value = token.slice("--work-tree=".length);
        }
        if (value === undefined) continue;

        const resolved = resolveToken(gitCwd, value);
        if (resolved.unresolved) {
          return {
            denial: deny(
              `Blocked: git is redirected with ${label}, whose target can't be verified — so it may ` +
                `operate on the main checkout. Use a literal path.`,
            ),
          };
        }
        if (
          resolved.targets.some((abs) => (isGitDir ? isProtectedGitState : isProtected)(scope, abs))
        ) {
          return {
            denial: deny(
              `Blocked: the command redirects git at ${protectedLabel(scope, resolved.targets[0] as string)}. ` +
                `Git here must operate on this worktree; drop -C/--git-dir/--work-tree.`,
            ),
          };
        }
        if (token === "-C" || (token.startsWith("-C") && token.length > 2)) {
          gitCwd = { dirs: resolved.targets, unknown: false };
        }
      }
    }

    // ── inline `GIT_*=<path>` assignments ──────────────────────────────────
    // Git resolves relative values after applying `-C`, while the shell word
    // itself is not path-resolved at all — so check both readings rather than
    // betting on one. `inheritedEnv` carries what an enclosing `env` already
    // bound for this child (see the `env` branch above).
    for (const token of [...inheritedEnv, ...tokens]) {
      const eq = token.indexOf("=");
      if (eq <= 0) continue;
      const name = token.slice(0, eq);
      if (!(GIT_REDIRECT_ENV as readonly string[]).includes(name)) continue;
      const value = token.slice(eq + 1);
      for (const base of [state, gitCwd]) {
        const resolved = resolveToken(base, value);
        if (resolved.unresolved) {
          return {
            denial: deny(
              `Blocked: the command sets ${name} to "${value}", whose target can't be verified — ` +
                `so the git it runs may land outside this worktree. Use a literal path.`,
            ),
          };
        }
        const hit = resolved.targets.find((abs) => isProtectedRedirect(scope, name, abs));
        if (hit !== undefined) {
          return {
            denial: deny(
              `Blocked: the command sets ${name} to ${protectedLabel(scope, hit)}. ` +
                `Git here must operate on this worktree; unset it or point it inside the worktree.`,
            ),
          };
        }
      }
    }

    return { state };
  };

  const walkProgram = (
    program: ShellPart[],
    initial: CwdState,
    depth: number,
    inheritedEnv: readonly string[] = [],
  ): Step => {
    const mentionsGit = /(^|[\s;&|(){}])git($|[\s;&|(){}])/.test(
      program.map((part) => part.text).join("\n"),
    );
    if (depth > MAX_SHELL_NESTING) {
      return mentionsGit
        ? {
            denial: deny(
              `Blocked: the command nests shell interpreters too deeply to verify where its git ` +
                `runs. Split it into plain, separate commands.`,
            ),
          }
        : { state: initial };
    }

    let state = initial;
    let segmentStart = state;
    let pipelineBase: CwdState | undefined;
    const frames: { state: CwdState; pipelineBase?: CwdState }[] = [];

    for (const part of program) {
      const { op, text } = part;
      if (op === "(") {
        frames.push(pipelineBase ? { state, pipelineBase } : { state });
        pipelineBase = undefined;
        segmentStart = state;
        // fall through: this text runs INSIDE the new scope
      } else if (op === ")") {
        const frame = frames.pop();
        if (frame) {
          state = frame.state;
          pipelineBase = frame.pipelineBase;
        }
        segmentStart = state;
        continue;
      } else if (op === "|") {
        // Every pipeline member runs in a subshell: its `cd` is confined, and
        // the parent shell is back where the pipeline started afterwards.
        if (pipelineBase === undefined) pipelineBase = segmentStart;
        state = pipelineBase;
        segmentStart = state;
        // fall through: this text is the member itself
      } else if (op === "&") {
        // A background job runs in a subshell; the parent is unaffected, while
        // the command AFTER `&` runs in the parent.
        state = segmentStart;
        pipelineBase = undefined;
        segmentStart = state;
      } else {
        if (pipelineBase !== undefined) {
          state = pipelineBase;
          pipelineBase = undefined;
        }
        segmentStart = state;
      }

      const tokens = withoutKeywords(tokenizeCommand(text));
      if (tokens.length === 0) continue;
      const step = walkTokens(tokens, state, mentionsGit, depth, inheritedEnv);
      if (step.denial) return step;
      // `&&` / `||` may not run this segment at all: keep both possibilities.
      state = op === "&&" || op === "||" ? union(segmentStart, step.state) : step.state;
    }

    return { state };
  };

  return walkProgram(splitShellProgram(opts.command), start, 0).denial;
}

/**
 * Decide whether a tool call would reach into the main checkout. Returns
 * undefined when the call is fine, so the caller can fall through to its normal
 * permission flow — this guard only ever DENIES, it never grants.
 */
export function worktreeIsolationDenial(
  guard: WorktreeGuardInput,
): WorktreeGuardDenial | undefined {
  const { main, gitDir, workspace, tool, input, path } = guard;
  // Normalize every root ONCE, here: each target below is canonicalized by
  // `resolveAgainst`, so a containment test must compare real paths on both
  // sides or a symlinked workspace (/tmp on macOS) would read as a foreign
  // repository and over-refuse.
  const scope: Scope = {
    checkouts: [workspace, ...(guard.checkouts ?? [])].map((p) => canonicalizePathSync("/", p)),
    workspace: canonicalizePathSync("/", workspace),
  };
  if (main) scope.main = canonicalizePathSync("/", main);
  if (gitDir) scope.gitDir = canonicalizePathSync("/", gitDir);

  if (FILE_WRITE_TOOLS.has(tool) && path) {
    const abs = canonicalizePathSync(scope.workspace, path);
    if (isProtected(scope, abs)) {
      return {
        reason:
          `Blocked: ${tool} targets ${protectedLabel(scope, abs)}. This session is isolated in ` +
          `a worktree — write inside it instead (${scope.workspace}).`,
      };
    }
  }

  if (!SHELL_TOOLS.has(tool)) return undefined;

  // The directory the command actually runs in: the gate canonicalized an
  // explicit `cwd`, so it is absolute here; without one the session workspace is
  // the base.
  const rawCwd = input.cwd;
  const explicitCwd =
    typeof rawCwd === "string" && rawCwd.length > 0
      ? canonicalizePathSync(scope.workspace, rawCwd)
      : scope.workspace;

  if (isProtected(scope, explicitCwd)) {
    return {
      reason:
        `Blocked: this command's working directory is ${protectedLabel(scope, explicitCwd)}. ` +
        `Run it inside the worktree (${scope.workspace}) instead, or drop the explicit cwd.`,
    };
  }

  // `env` reaches the child only where the tool actually forwards it: monitor
  // always, bash only for background commands. Checking it for foreground bash
  // would deny on a field the tool ignores.
  const honoursEnv = tool === "monitor" || (tool === "bash" && input.run_in_background === true);
  const env = input.env;
  if (honoursEnv && env && typeof env === "object") {
    for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
      if (!(GIT_REDIRECT_ENV as readonly string[]).includes(name)) continue;
      if (typeof value !== "string" || value.length === 0) continue;
      // GIT_ALTERNATE_OBJECT_DIRECTORIES is a path list; check every entry.
      const entries = name === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ? value.split(":") : [value];
      for (const entry of entries) {
        const abs = resolveAgainst(explicitCwd, entry);
        if (!abs) {
          return {
            reason:
              `Blocked: this command's environment sets ${name} to "${entry}", whose target can't ` +
              `be verified — so the git it runs may land outside this worktree. Use a literal path.`,
          };
        }
        if (isProtectedRedirect(scope, name, abs)) {
          return {
            reason:
              `Blocked: this command's environment points git at ` +
              `${protectedLabel(scope, abs)} (${name}=${entry}). ` +
              `Git here must operate on this worktree.`,
          };
        }
      }
    }
  }

  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return undefined;

  const walked = commandDenial({ scope, command, startCwd: explicitCwd });
  if (walked) return walked;

  if (/\bgit\b/.test(command) && /`|\$\(|\$\{!|<\s*\(/.test(command)) {
    return {
      reason:
        "Blocked: this command runs git but hides part of itself in a dynamic expansion " +
        "($(…), backticks, ${!…}, or <(…)), so its effect on the worktree can't be " +
        "verified. Split it into plain, separate commands (compute the value first, " +
        "then pass it literally).",
    };
  }

  return undefined;
}
