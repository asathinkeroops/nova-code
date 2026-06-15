import { resolve } from "node:path";
import { execa, type ExecaError } from "execa";
import type { Agent } from "@nova/agent";
import type { ToolResultBlock, ToolUseBlock } from "@nova/core";
import type { HookCommandConfig, Settings } from "@nova/runtime";

/**
 * Bridge user-declared shell hooks (`settings.hooks`) onto the agent's in-code
 * HookRegistry. The kernel is untouched: each configured event maps to an
 * `agent.on(...)` registration that shells out via the same sandbox + executor
 * the `bash` tool uses.
 *
 * Hooks receive their event context as a single JSON object on **stdin**
 * (Claude Code convention): the common fields `hook_event_name`, `session_id`,
 * `transcript_path`, and `cwd`, plus event-specific fields (`tool_name`,
 * `tool_input`, `tool_response`, `prompt`, `source`, `trigger`, …).
 *
 * Hooks reply either by **exit code** (the simple path) or by writing a **JSON
 * control object to stdout** (`parseHookOutput`). When stdout is a recognized
 * JSON object its structured decision wins; otherwise we fall back to the
 * exit-code + raw-stdout semantics. Supported output fields:
 * - `decision: "block" | "approve"` + `reason`
 * - `hookSpecificOutput.permissionDecision: "deny" | "allow" | "ask"`
 *   (+ `permissionDecisionReason`) — PreToolUse only: `deny` blocks the tool,
 *   `allow` bypasses the permission gate (mode + rules), `ask` forces an
 *   interactive confirmation even when the gate would auto-allow.
 * - `hookSpecificOutput.additionalContext` — appended to the model-facing text
 *   for PostToolUse / UserPromptSubmit (replaces raw stdout when present).
 *
 * Event semantics (see the `hooks` schema in `@nova/runtime`):
 * - PreToolUse      → consulted by the CLI's permission gate via
 *                     `evaluatePreToolUse(...)` (NOT a loop hook), so a hook can
 *                     deny / allow (bypass) / ask (force a prompt). non-zero exit
 *                     DENIES; JSON `permissionDecision` drives allow/ask/deny.
 * - PostToolUse     → `post_tool_use` (blocking): stdout is appended to the
 *                     tool result; non-zero exit also flags it as an error.
 * - UserPromptSubmit→ `pre_user_prompt` (blocking): stdout is appended to the
 *                     user input; non-zero exit ABORTS the turn.
 *
 * Stop and the lifecycle events (SessionStart / SessionEnd / PreCompact /
 * PostCompact) have no agent-loop hook point; the CLI drives them directly at
 * the matching site (REPL start/exit/end-of-turn, session switch, compaction):
 * - `fire(...)`            — advisory side effect (SessionStart/End, PostCompact).
 * - `firePreCompact(...)`  — PreCompact; **exit 2 blocks** the compaction.
 * - `runStop(...)`         — Stop; **exit 2 forces the turn to continue**.
 * Following the Claude Code convention, exit code 2 is the blocking signal;
 * other non-zero exits are non-blocking errors (logged). `matcher` tests the
 * source/trigger ("startup", "auto", …).
 */

const MAX_HOOK_OUTPUT = 50_000;

/** Canonical event name placed in every payload's `hook_event_name`. */
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "PostCompact";

export interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HookRunner {
  (
    command: string,
    opts: { cwd: string; input: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<HookRunResult>;
}

export interface UserHooksDeps {
  config: Settings["hooks"];
  cwd: string;
  /** Current turn abort signal, read lazily at fire time. */
  getSignal: () => AbortSignal | undefined;
  /** Session identity, read lazily and injected into every payload. */
  getSession: () => { id: string; transcriptPath: string };
  /** Confine the command (e.g. `sandbox.bridge.wrapCommand`); identity if absent. */
  wrapCommand?: (command: string, signal?: AbortSignal) => Promise<string>;
  /** Injectable executor (tests). Defaults to an execa-based runner. */
  run?: HookRunner;
  onError?: (message: string) => void;
}

/** Lifecycle events fired directly by the CLI (not via the agent loop). */
export type LifecycleEvent = "SessionStart" | "SessionEnd" | "PreCompact" | "PostCompact";

const defaultRunner: HookRunner = async (command, { cwd, input, timeoutMs, signal }) => {
  try {
    const result = await execa(command, {
      shell: "/bin/bash",
      cwd,
      input,
      timeout: timeoutMs,
      reject: false,
      ...(signal ? { cancelSignal: signal } : {}),
    });
    return {
      exitCode: result.exitCode ?? (result.failed ? 1 : 0),
      stdout: (result.stdout ?? "").slice(0, MAX_HOOK_OUTPUT),
      stderr: (result.stderr ?? "").slice(0, MAX_HOOK_OUTPUT),
    };
  } catch (err) {
    const e = err as ExecaError;
    return { exitCode: 1, stdout: "", stderr: e.shortMessage ?? e.message ?? String(err) };
  }
};

/**
 * Keep hooks whose `matcher` regex tests true against `subject` (or that have no
 * matcher). `subject` is the tool name for *ToolUse events, or the source /
 * trigger string for lifecycle events (e.g. "startup", "auto").
 */
export function selectHooks(
  hooks: readonly HookCommandConfig[],
  subject: string,
): HookCommandConfig[] {
  return hooks.filter((h) => {
    if (!h.matcher) return true;
    try {
      return new RegExp(h.matcher).test(subject);
    } catch {
      // An un-compilable matcher matches nothing rather than throwing mid-loop.
      return false;
    }
  });
}

/** Flatten a tool result's content to a plain string. */
export function resultText(result: ToolResultBlock): string {
  if (typeof result.content === "string") return result.content;
  return result.content.map((b) => b.text).join("");
}

/** Absolute path(s) a write/edit touched, for `file_paths`; undefined otherwise. */
function filePathsFor(cwd: string, use: ToolUseBlock): string | undefined {
  if (use.name !== "write" && use.name !== "edit") return undefined;
  const p = (use.input as { path?: unknown }).path;
  if (typeof p !== "string" || p.length === 0) return undefined;
  return resolve(cwd, p);
}

/** Build the event-specific payload fields for a tool-scoped hook. */
export function toolFields(
  cwd: string,
  use: ToolUseBlock,
  result?: ToolResultBlock,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    tool_name: use.name,
    tool_input: use.input,
  };
  const path = filePathsFor(cwd, use);
  if (path) fields.file_paths = [path];
  if (result) {
    fields.tool_response = resultText(result);
    fields.is_error = result.is_error ?? false;
  }
  return fields;
}

/** Normalized view of a hook's JSON stdout control object. */
export interface HookOutput {
  decision?: "approve" | "block";
  reason?: string;
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  additionalContext?: string;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Parse a hook's stdout as a JSON control object (Claude Code convention).
 * Returns null for plain text, non-object JSON, or an object carrying none of
 * the recognized control fields — in which case callers fall back to the
 * exit-code + raw-stdout semantics. Unknown keys are ignored.
 */
export function parseHookOutput(stdout: string): HookOutput | null {
  const trimmed = stdout.trim();
  if (trimmed[0] !== "{") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const hso =
    typeof r.hookSpecificOutput === "object" && r.hookSpecificOutput !== null
      ? (r.hookSpecificOutput as Record<string, unknown>)
      : {};

  const out: HookOutput = {};
  if (r.decision === "approve" || r.decision === "block") out.decision = r.decision;
  const reason = asString(r.reason);
  if (reason !== undefined) out.reason = reason;
  if (
    hso.permissionDecision === "allow" ||
    hso.permissionDecision === "deny" ||
    hso.permissionDecision === "ask"
  ) {
    out.permissionDecision = hso.permissionDecision;
  }
  const pdr = asString(hso.permissionDecisionReason);
  if (pdr !== undefined) out.permissionDecisionReason = pdr;
  const ac = asString(hso.additionalContext);
  if (ac !== undefined) out.additionalContext = ac;

  return Object.keys(out).length > 0 ? out : null;
}

/** A PreToolUse hook's verdict, consumed by the CLI permission gate. */
export type PreToolUseVerdict =
  | { decision: "none" }
  | { decision: "allow" }
  | { decision: "ask"; reason?: string }
  | { decision: "deny"; reason: string };

/**
 * Resolve a single PreToolUse hook run to deny/allow/ask/none.
 * `permissionDecision` wins; then legacy `decision`; else the exit code
 * (non-zero → deny, zero → none = "no opinion, defer to the gate").
 */
function preToolDecision(out: HookOutput | null, exitCode: number): "deny" | "allow" | "ask" | "none" {
  if (out?.permissionDecision) {
    if (out.permissionDecision === "deny") return "deny";
    if (out.permissionDecision === "ask") return "ask";
    return "allow";
  }
  if (out?.decision) return out.decision === "block" ? "deny" : "allow";
  return exitCode !== 0 ? "deny" : "none";
}

export class UserHooks {
  private readonly run: HookRunner;

  private readonly report: (message: string) => void;

  constructor(private readonly deps: UserHooksDeps) {
    this.run = deps.run ?? defaultRunner;
    this.report = deps.onError ?? (() => {});
  }

  /**
   * Run one hook command, feeding it the event payload as JSON on stdin. The
   * common fields (`hook_event_name`, `session_id`, `transcript_path`, `cwd`)
   * are injected here so call sites only supply event-specific fields.
   */
  private async exec(
    hook: HookCommandConfig,
    event: HookEventName,
    fields: Record<string, unknown>,
  ): Promise<HookRunResult> {
    const { cwd } = this.deps;
    const session = this.deps.getSession();
    const signal = this.deps.getSignal();
    const payload = {
      hook_event_name: event,
      session_id: session.id,
      transcript_path: session.transcriptPath,
      cwd,
      ...fields,
    };
    const command = this.deps.wrapCommand
      ? await this.deps.wrapCommand(hook.command, signal)
      : hook.command;
    return this.run(command, {
      cwd,
      input: JSON.stringify(payload),
      timeoutMs: hook.timeout_ms,
      signal,
    });
  }

  /**
   * Evaluate PreToolUse hooks for one tool call. Consulted by the CLI's
   * permission gate (`checkPermission`) — NOT registered as a loop hook — so a
   * hook can deny, allow (bypass the gate), or ask (force a prompt). Precedence
   * across matched hooks: a deny short-circuits; otherwise ask > allow > none.
   */
  async evaluatePreToolUse(tool: string, input: unknown): Promise<PreToolUseVerdict> {
    const { config, cwd } = this.deps;
    if (!config.enabled || config.PreToolUse.length === 0) return { decision: "none" };
    const use: ToolUseBlock = {
      type: "tool_use",
      id: "",
      name: tool,
      input: (input ?? {}) as Record<string, unknown>,
    };
    let pending: PreToolUseVerdict = { decision: "none" };
    for (const hook of selectHooks(config.PreToolUse, tool)) {
      const res = await this.exec(hook, "PreToolUse", toolFields(cwd, use));
      const out = parseHookOutput(res.stdout);
      const verdict = preToolDecision(out, res.exitCode);
      if (verdict === "deny") {
        const reason =
          out?.permissionDecisionReason?.trim() ||
          out?.reason?.trim() ||
          res.stderr.trim() ||
          res.stdout.trim() ||
          `blocked by PreToolUse hook (exit ${res.exitCode})`;
        return { decision: "deny", reason };
      }
      if (verdict === "ask" && pending.decision !== "ask") {
        const reason = out?.permissionDecisionReason?.trim() || out?.reason?.trim();
        pending = reason ? { decision: "ask", reason } : { decision: "ask" };
      } else if (verdict === "allow" && pending.decision === "none") {
        pending = { decision: "allow" };
      }
    }
    return pending;
  }

  /** Wire the two agent-loop events onto the agent's HookRegistry. */
  register(on: Agent["on"]): void {
    const { config, cwd } = this.deps;
    if (!config.enabled) return;

    // PostToolUse — append stdout to the result fed back to the model.
    if (config.PostToolUse.length > 0) {
      on("post_tool_use", async ({ use, result }) => {
        const matched = selectHooks(config.PostToolUse, use.name);
        if (matched.length === 0) return undefined;

        const wasError = result.is_error ?? false;
        let isError = wasError;
        const notes: string[] = [];
        for (const hook of matched) {
          const res = await this.exec(hook, "PostToolUse", toolFields(cwd, use, result));
          const out = parseHookOutput(res.stdout);
          // Structured `additionalContext` replaces raw stdout when present.
          const note = out ? out.additionalContext?.trim() : res.stdout.trim();
          if (note) notes.push(note);
          if (out?.decision === "block") {
            isError = true;
            const reason = out.reason?.trim();
            if (reason) notes.push(reason);
          }
          if (res.exitCode !== 0) {
            isError = true;
            const err = res.stderr.trim();
            notes.push(`PostToolUse hook failed (exit ${res.exitCode})${err ? `: ${err}` : ""}`);
          }
        }

        if (notes.length === 0 && isError === wasError) return undefined;
        const base = resultText(result);
        const content =
          notes.length > 0 ? `${base}\n\n[PostToolUse hook]\n${notes.join("\n")}` : base;
        return { result: { ...result, content, is_error: isError } };
      });
    }

    // UserPromptSubmit — append stdout to the input; non-zero exit aborts.
    if (config.UserPromptSubmit.length > 0) {
      on("pre_user_prompt", async ({ input }) => {
        const notes: string[] = [];
        for (const hook of config.UserPromptSubmit) {
          const res = await this.exec(hook, "UserPromptSubmit", { prompt: input });
          const out = parseHookOutput(res.stdout);
          const aborted = out?.decision ? out.decision === "block" : res.exitCode !== 0;
          if (aborted) {
            const reason =
              out?.reason?.trim() ||
              res.stderr.trim() ||
              res.stdout.trim() ||
              `blocked by UserPromptSubmit hook (exit ${res.exitCode})`;
            return { abort: true, reason };
          }
          // Structured `additionalContext` replaces raw stdout when present.
          const note = out ? out.additionalContext?.trim() : res.stdout.trim();
          if (note) notes.push(note);
        }
        if (notes.length === 0) return undefined;
        return { input: `${input}\n\n${notes.join("\n")}` };
      });
    }

    // Stop is NOT registered here — it is REPL-driven via runStop() so it can
    // force the turn to continue (an agent post_turn hook cannot re-run a turn).
  }

  /**
   * Run an event's hooks until one returns the blocking exit code (2). Other
   * non-zero exits are reported as non-blocking errors. Shared by firePreCompact
   * and runStop.
   */
  private async runUntilBlock(
    event: LifecycleEvent | "Stop",
    subject: string,
    fields: Record<string, unknown>,
  ): Promise<{ blocked: boolean; reason?: string }> {
    const { config } = this.deps;
    if (!config.enabled) return { blocked: false };
    for (const hook of selectHooks(config[event], subject)) {
      const res = await this.exec(hook, event, fields);
      const out = parseHookOutput(res.stdout);
      // `decision: "block"` wins; else the exit-2 convention.
      const blocked = out?.decision ? out.decision === "block" : res.exitCode === 2;
      if (blocked) {
        const reason = out?.reason?.trim() || res.stderr.trim() || res.stdout.trim();
        return reason ? { blocked: true, reason } : { blocked: true };
      }
      if (res.exitCode !== 0 && res.exitCode !== 2) {
        this.report(
          `${event} hook exited ${res.exitCode}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}`,
        );
      }
    }
    return { blocked: false };
  }

  /** PreCompact — exit 2 blocks the (auto or manual) compaction. */
  async firePreCompact(
    opts: { subject?: string; fields?: Record<string, unknown> } = {},
  ): Promise<{ blocked: boolean; reason?: string }> {
    return this.runUntilBlock("PreCompact", opts.subject ?? "", opts.fields ?? {});
  }

  /** Stop — exit 2 forces the turn to continue, with the hook's stderr as guidance. */
  async runStop(
    fields: Record<string, unknown> = {},
  ): Promise<{ continue: boolean; reason?: string }> {
    const r = await this.runUntilBlock("Stop", "", fields);
    if (!r.blocked) return { continue: false };
    return r.reason !== undefined ? { continue: true, reason: r.reason } : { continue: true };
  }

  /**
   * Fire a lifecycle event's hooks directly (advisory — side effect only).
   * `subject` is matched against each hook's `matcher`; the caller passes the
   * event's source/trigger string (e.g. "startup", "auto") and any
   * event-specific payload `fields`.
   */
  async fire(
    event: LifecycleEvent,
    opts: { subject?: string; fields?: Record<string, unknown> } = {},
  ): Promise<void> {
    const { config } = this.deps;
    if (!config.enabled) return;
    const hooks = selectHooks(config[event], opts.subject ?? "");
    for (const hook of hooks) {
      try {
        const res = await this.exec(hook, event, opts.fields ?? {});
        if (res.exitCode !== 0) {
          this.report(
            `${event} hook exited ${res.exitCode}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}`,
          );
        }
      } catch (err) {
        this.report(`${event} hook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
