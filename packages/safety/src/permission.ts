import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { PermissionRule } from "@nova/base";
import { isDangerousBash } from "@nova/base";

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionDecision {
  effect: PermissionEffect;
  reason: string;
  matchedRule?: PermissionRule;
}

export interface PermissionInput {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Answers an approval prompt can produce:
 * - `yes` / `no` — this call only.
 * - `always-allow` — this tool for the rest of the session.
 * - `always-allow-dir` — reads under this call's directory for the rest of the
 *   session (only offered for path-bearing read tools; see
 *   {@link sessionGrantDir}). Sensitive targets never qualify.
 */
export type AskAnswer = "yes" | "no" | "always-allow" | "always-allow-dir";

export type AskCallback = (
  decision: PermissionDecision,
  input: PermissionInput,
) => Promise<AskAnswer>;

export interface PermissionConfig {
  defaultEffect: PermissionEffect;
  rules: PermissionRule[];
  ask?: AskCallback;
}

export class PermissionDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly reason: string,
  ) {
    super(`Permission denied for tool "${tool}": ${reason}`);
    this.name = "PermissionDeniedError";
  }
}

/** True when `child` is `parent` itself or nested under it. Both must be
 *  absolute, normalized paths — `relative` then yields "" or a non-".." rel.
 *  Exported so callers (e.g. the CLI's accept-edits mode) can reuse the exact
 *  same containment predicate the `within` matcher uses, keeping their notion
 *  of "inside the workspace" from drifting from the engine's. */
export function isWithin(parent: string, child: string): boolean {
  if (!isAbsolute(parent) || !isAbsolute(child)) return false;
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * macOS exposes `/etc`, `/tmp` and `/var` through `/private/...` once a path is
 * realpath'd. Stripping the prefix on both sides keeps prefix comparisons
 * working on either form.
 */
function withoutPrivate(p: string): string {
  return p.replace(/^\/private(?=\/)/, "");
}

const HOME = homedir();

/**
 * Directories whose contents are credentials, keys, or private history. A read
 * inside one of these is never covered by a directory-scoped session grant (the
 * user still gets a per-call prompt), and the "allow this directory" option is
 * hidden for it — so one careless "allow ~" cannot silently expose `~/.ssh`.
 * An explicit user rule in `permissions.rules` still wins, as always.
 */
const SENSITIVE_READ_PREFIXES: readonly string[] = [
  join(HOME, ".ssh"),
  join(HOME, ".aws"),
  join(HOME, ".azure"),
  join(HOME, ".gcloud"),
  join(HOME, ".gnupg"),
  join(HOME, ".kube"),
  join(HOME, ".docker"),
  join(HOME, ".netrc"),
  join(HOME, ".npmrc"),
  join(HOME, ".pypirc"),
  join(HOME, ".git-credentials"),
  join(HOME, ".password-store"),
  join(HOME, ".local/share/keyrings"),
  join(HOME, ".config/gh"),
  join(HOME, ".config/gcloud"),
  join(HOME, ".config/hub"),
  join(HOME, ".mozilla"),
  join(HOME, ".nova"),
  join(HOME, ".bash_history"),
  join(HOME, ".zsh_history"),
  join(HOME, "Library/Keychains"),
  join(HOME, "Library/Application Support/Google/Chrome"),
  join(HOME, "Library/Application Support/Firefox"),
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/ssh",
  "/etc/ssl/private",
  "/Library/Keychains",
];

const SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials(\.json)?$/i,
  /^\.?netrc$/i,
];

const SENSITIVE_EXTENSION_PATTERN = /\.(pem|key|p12|pfx|keystore|jks|ppk)$/i;

/** Tools whose out-of-workspace reads may be granted a directory for the session. */
const READ_SESSION_TOOLS: ReadonlySet<string> = new Set(["read", "glob", "grep"]);

/**
 * True when a canonical path is a credential store, a key, or private history.
 * Directory-scoped session grants skip these so a broad "allow this folder"
 * does not silently widen to secrets; a per-call approval remains possible.
 */
export function isSensitiveReadPath(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const normalized = withoutPrivate(path);
  if (SENSITIVE_READ_PREFIXES.some((prefix) => isWithin(withoutPrivate(prefix), normalized))) {
    return true;
  }
  const name = basename(normalized);
  return (
    SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(name)) ||
    SENSITIVE_EXTENSION_PATTERN.test(name)
  );
}

/**
 * The directory an "always allow reads here" answer would cover, or undefined
 * when the option must not be offered.
 *
 * Scope follows the tool's semantics rather than the filesystem: `read` targets
 * a file, so the grant is its parent directory; `glob`/`grep` target a search
 * root, so the grant is that path itself (which may be a file — a narrower
 * grant is fine). Sensitive targets/directories and the filesystem root are
 * excluded, so reading `/` or `~/.ssh/id_rsa` can never mint a broad grant.
 *
 * `input.path` must already be canonical (the CLI's permission gate does this);
 * a relative path returns undefined because containment cannot be judged.
 */
export function sessionGrantDir(tool: string, input: PermissionInput["input"]): string | undefined {
  if (!READ_SESSION_TOOLS.has(tool)) return undefined;
  const raw = input.path;
  if (typeof raw !== "string" || raw.length === 0 || !isAbsolute(raw)) return undefined;
  const dir = tool === "read" ? dirname(raw) : raw;
  if (!isAbsolute(dir) || withoutPrivate(dir) === "/") return undefined;
  if (isSensitiveReadPath(raw) || isSensitiveReadPath(dir)) return undefined;
  return dir;
}

/** Structured path-containment matcher: `{ within: ["/abs/root", ...] }`.
 *  Used by workspace rules in place of a regex. The matched value must be a
 *  pre-canonicalized absolute path (the CLI canonicalizes path-bearing tool
 *  inputs before evaluation), so containment compares real on-disk locations
 *  rather than the raw string the model supplied. */
function isWithinMatcher(v: unknown): v is { within: string[] } {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { within?: unknown }).within) &&
    (v as { within: unknown[] }).within.every((x) => typeof x === "string")
  );
}

function matchValue(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (isWithinMatcher(expected)) {
    return typeof actual === "string" && expected.within.some((root) => isWithin(root, actual));
  }
  if (typeof expected === "string" && typeof actual === "string") {
    if (expected.startsWith("/") && expected.endsWith("/") && expected.length > 2) {
      try {
        return new RegExp(expected.slice(1, -1)).test(actual);
      } catch {
        return false;
      }
    }
  }
  if (
    typeof expected === "object" &&
    expected !== null &&
    typeof actual === "object" &&
    actual !== null
  ) {
    return Object.entries(expected).every(([k, v]) =>
      matchValue(v, (actual as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function ruleMatches(rule: PermissionRule, req: PermissionInput): boolean {
  if (rule.tool !== req.tool && rule.tool !== "*") return false;
  if (!rule.match) return true;
  return Object.entries(rule.match).every(([k, v]) => matchValue(v, req.input[k]));
}

export class PermissionEngine {
  private runtimeAllow = new Map<string, Set<string>>();
  /** Directory-scoped session grants: canonical dir → everything under it. */
  private runtimeAllowDirs = new Map<string, string[]>();

  constructor(private readonly config: PermissionConfig) {}

  evaluate(req: PermissionInput): PermissionDecision {
    if (req.tool === "bash") {
      const cmd = (req.input as { command?: string }).command;
      if (typeof cmd === "string" && isDangerousBash(cmd)) {
        return {
          effect: "deny",
          reason: `bash command matched dangerous pattern: ${cmd}`,
        };
      }
    }

    try {
      const runtimeBucket = this.runtimeAllow.get(req.tool);
      if (runtimeBucket?.has(stableInputKey(req.input))) {
        return { effect: "allow", reason: "runtime always-allow" };
      }
      if (runtimeBucket?.has("*")) {
        return { effect: "allow", reason: "runtime always-allow-tool" };
      }
      if (this.dirGrantCovers(req)) {
        return { effect: "allow", reason: "runtime always-allow-dir" };
      }

      for (const rule of this.config.rules) {
        if (ruleMatches(rule, req)) {
          return {
            effect: rule.effect,
            reason: `matched rule: ${rule.tool} → ${rule.effect}`,
            matchedRule: rule,
          };
        }
      }
      return {
        effect: this.config.defaultEffect,
        reason: `default effect: ${this.config.defaultEffect}`,
      };
    } catch (err) {
      // Any throw from match evaluation (bad regex source we didn't catch,
      // Proxy getters on the input, JSON.stringify in stableInputKey, etc.)
      // degrades to `ask` rather than crashing the turn. We deliberately
      // don't downgrade to `deny` — that would let a misconfigured rule
      // silently block tools; `ask` keeps the user in the loop.
      return {
        effect: "ask",
        reason: `permission evaluation error, fallback to ask: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * The first matching CONFIGURED rule, but only when that rule denies.
   *
   * Hosts apply some grants ahead of {@link evaluate} — the CLI's permission
   * modes (`acceptEdits`/`auto` auto-grant in-workspace writes, `auto` runs
   * classifier-cleared commands) and the classifier's own fallback prompt. A
   * user rule saying `deny` must outrank all of them, so those paths call this
   * first. First-match-wins is preserved exactly as in `evaluate`: an earlier
   * allow/ask rule means "there is no denial here", so a later deny is not
   * resurrected against the rule order the user wrote.
   *
   * Deliberately narrower than `evaluate`: it does not run the built-in
   * `isDangerousBash` hard-deny, the runtime allow buckets, or `defaultEffect`.
   * Hosts use it only to detect an explicit rule denial; everything else stays
   * on the path they own.
   */
  deniedByRule(req: PermissionInput): PermissionDecision | undefined {
    try {
      for (const rule of this.config.rules) {
        if (!ruleMatches(rule, req)) continue;
        return rule.effect === "deny"
          ? {
              effect: "deny",
              reason: `matched rule: ${rule.tool} → deny`,
              matchedRule: rule,
            }
          : undefined;
      }
      return undefined;
    } catch {
      // A throwing matcher (Proxy input, exotic value) leaves the rule
      // undecidable. Degrade to "no denial here": the host's remaining gate
      // still runs, and `evaluate` will surface a reasoned `ask` if it is
      // reached. Failing closed here would let one broken rule block every
      // tool the mode shortcuts cover.
      return undefined;
    }
  }

  /**
   * True when a previous session grant covers this call: "always allow this
   * tool" or "always allow reads under <dir>". Hosts that short-circuit
   * {@link evaluate} (the CLI's auto-mode classifier path) consult this first so
   * a remembered grant survives the shortcut.
   */
  isSessionAllowed(req: PermissionInput): boolean {
    const bucket = this.runtimeAllow.get(req.tool);
    if (bucket?.has("*")) return true;
    if (bucket) {
      try {
        if (bucket.has(stableInputKey(req.input))) return true;
      } catch {
        // Exotic input (BigInt, Proxy) — fall through to the directory grants.
      }
    }
    return this.dirGrantCovers(req);
  }

  /**
   * Remember "always allow this tool" for the rest of the session. Exposed for
   * hosts whose approval prompt runs outside {@link check} (auto mode's
   * classifier fallback), so they record the same tool-scoped grant.
   */
  allowToolForSession(tool: string): void {
    const bucket = this.runtimeAllow.get(tool) ?? new Set<string>();
    bucket.add("*");
    this.runtimeAllow.set(tool, bucket);
  }

  /**
   * Remember "always allow reads under `dir`" for the rest of the session.
   *
   * Applies to the whole read family (`read`/`glob`/`grep`) regardless of which
   * one raised the prompt — the user granted a directory for reading, and the
   * three tools are three ways to read it. Non-read tools stay tool-scoped.
   * Nested grants are collapsed (a parent subsumes its children) so a session
   * that walks up and down a tree doesn't accumulate a long list.
   */
  allowDirectoryForSession(tool: string, dir: string): void {
    if (!isAbsolute(dir)) return;
    const tools = READ_SESSION_TOOLS.has(tool) ? READ_SESSION_TOOLS : new Set([tool]);
    for (const t of tools) this.addDirGrant(t, dir);
  }

  /** Merge one directory into a tool's grant list, collapsing nesting. */
  private addDirGrant(tool: string, dir: string): void {
    const list = this.runtimeAllowDirs.get(tool) ?? [];
    const next = list.filter((existing) => !isWithin(dir, existing));
    if (!next.some((existing) => isWithin(existing, dir))) next.push(dir);
    this.runtimeAllowDirs.set(tool, next);
  }

  /**
   * True when a directory-scoped grant covers this call. The target must be an
   * absolute path, must not be a credential/key path (a broad "allow ~" must
   * not silently expose `~/.ssh`), and must sit inside a granted directory.
   */
  private dirGrantCovers(req: PermissionInput): boolean {
    const dirs = this.runtimeAllowDirs.get(req.tool);
    if (!dirs || dirs.length === 0) return false;
    const target = (req.input as { path?: unknown }).path;
    if (typeof target !== "string" || !isAbsolute(target)) return false;
    if (isSensitiveReadPath(target)) return false;
    return dirs.some((dir) => isWithin(dir, target));
  }

  async check(req: PermissionInput): Promise<PermissionDecision> {
    const decision = this.evaluate(req);
    if (decision.effect === "deny") {
      throw new PermissionDeniedError(req.tool, decision.reason);
    }
    if (decision.effect === "allow") return decision;

    if (!this.config.ask) {
      throw new PermissionDeniedError(
        req.tool,
        `tool requires confirmation but no ask callback was configured`,
      );
    }
    const answer = await this.config.ask(decision, req);
    if (answer === "no") {
      throw new PermissionDeniedError(req.tool, "user denied at prompt");
    }
    if (answer === "always-allow") this.allowToolForSession(req.tool);
    if (answer === "always-allow-dir") {
      const dir = sessionGrantDir(req.tool, req.input);
      if (dir) this.allowDirectoryForSession(req.tool, dir);
    }
    return { effect: "allow", reason: `user approved (${answer})` };
  }
}

function stableInputKey(input: Record<string, unknown>): string {
  return JSON.stringify(input, Object.keys(input).sort());
}
