import type { PermissionRule, Settings } from "@nova/runtime";
import { isWithin } from "@nova/safety";

/**
 * Input-box permission mode, cycled with shift+tab. Stored in the UI store and
 * read by the CLI's `checkPermission` closure to bias tool gating:
 *
 * - `default`    — no change; write/edit/bash fall through to the engine's `ask`.
 * - `acceptEdits`— in-workspace write/edit auto-granted (no prompt); bash and
 *                  out-of-workspace write/edit still ask.
 * - `auto`       — autonomous: in-workspace write/edit auto-granted like
 *                  `acceptEdits`, and additionally the command tools (bash,
 *                  runInBackground) auto-run without a prompt. More permissive
 *                  than `acceptEdits` (arbitrary commands run unattended) but
 *                  still narrower than `bypassPermissions` — out-of-workspace
 *                  write/edit and user `deny` rules are NOT bypassed. Mirrors
 *                  Claude Code's `auto` mode (minus its background classifier).
 * - `plan`       — read-only; write/edit/bash are denied (mirrors the read-only
 *                  `/plan` sub-agent), so the agent investigates and plans only.
 * - `bypassPermissions` — every approval auto-granted (the
 *                  `--dangerously-skip-permissions` bypass). Only reachable in
 *                  the shift+tab cycle once that startup flag has armed it.
 */
export type PermissionMode = "default" | "acceptEdits" | "auto" | "plan" | "bypassPermissions";

/**
 * Workspace-mutating tools, withheld in `plan` mode. Mirrors the read-only
 * sub-agent's MUTATING_TOOLS set (packages/subagent/src/subagent.ts).
 */
const MODE_MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

/**
 * Command-execution tools that `auto` mode runs unattended — but only after a
 * risk classifier clears them (see auto-classify.ts). Unlike the synchronous
 * edit grant, command gating is async (it may call the model), so it lives in
 * `checkPermission` rather than `resolveModeDecision`; this set just tells the
 * caller which tools to route through the classifier. Both spawn an arbitrary
 * shell (`runInBackground` is the background variant of `bash`).
 */
export const MODE_COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "runInBackground"]);

/**
 * Mode-specific permission decision, applied by `checkPermission` AFTER it has
 * canonicalized the tool's `path` and BEFORE consulting the PermissionEngine.
 * Returns a concrete `{ granted }` to short-circuit, or `null` to defer to the
 * engine's normal rules. `canonicalPath` is the already-resolved+realpath'd
 * path for path-bearing tools (undefined otherwise); `roots` is the canonical
 * workspace allow-list the engine itself uses.
 */
export function resolveModeDecision(
  mode: PermissionMode,
  tool: string,
  canonicalPath: string | undefined,
  roots: readonly string[],
): { granted: boolean; reason?: string } | null {
  if (mode === "plan" && MODE_MUTATING_TOOLS.has(tool)) {
    return {
      granted: false,
      reason:
        "Plan mode is on (read-only): the write, edit, and bash tools are disabled. " +
        "Investigate the relevant code and present a concrete step-by-step plan instead " +
        "of changing anything; the user can turn off plan mode (shift+tab) to apply it.",
    };
  }
  // In-workspace write/edit auto-grant, shared by `acceptEdits` and `auto`.
  // Out-of-workspace paths (and a missing path) fall through to the engine's ask.
  if ((mode === "acceptEdits" || mode === "auto") && (tool === "write" || tool === "edit")) {
    if (canonicalPath !== undefined && roots.some((root) => isWithin(root, canonicalPath))) {
      return { granted: true };
    }
  }
  // `auto` mode's command tools (bash, runInBackground) are gated by an async
  // risk classifier in `checkPermission`, not here — see MODE_COMMAND_TOOLS.
  return null;
}

/**
 * Built-in tools the CLI always seeds as `allow`. These names mirror the
 * handlers registered by `builtinTools()` in @nova/tools; if you add a new
 * read-only/safe builtin tool, add it here too.
 *
 * `read`, `glob`, and `grep` are NOT here — they get workspace-scoped rules
 * from `workspaceReadRules(roots)` so a call whose canonical (resolved +
 * realpath'd) path lands inside the workspace allows, while one pointing
 * outside (off-cwd absolutes, `..` traversal, or symlink escape) falls through
 * to `ask`. glob/grep used to be flat `allow`, which let the model enumerate or
 * search arbitrary out-of-tree files; fencing their search root closes that.
 *
 * @nova/runtime ships a schema-only default of `rules: []` so the runtime
 * package stays free of tool-identifier knowledge.
 */
export const DEFAULT_PERMISSION_RULES: readonly PermissionRule[] = [
  { tool: "askUserQuestion", effect: "allow" },
  { tool: "createTodo", effect: "allow" },
  { tool: "updateTodo", effect: "allow" },
  { tool: "getTodoList", effect: "allow" },
  { tool: "clearTodoList", effect: "allow" },
  { tool: "createTask", effect: "allow" },
  { tool: "updateTask", effect: "allow" },
  { tool: "getTaskList", effect: "allow" },
  { tool: "clearTaskList", effect: "allow" },
  { tool: "loadSkill", effect: "allow" },
  // The lsp tool is read-only (queries language servers; never mutates files).
  { tool: "lsp", effect: "allow" },
  // Managing a command we already launched is safe to auto-allow: reading its
  // buffered output is read-only, and killing only targets a child nova spawned.
  // (runInBackground itself stays `ask` — it spawns arbitrary shell, like bash.)
  { tool: "getBackgroundOutput", effect: "allow" },
  { tool: "killBackground", effect: "allow" },
  // Spawning a sub-agent is itself safe to auto-allow: the sub-agent's own tool
  // calls run through this same PermissionEngine, so its bash/write/edit still
  // hit `ask`. Allowing the spawn just avoids a prompt for the delegation step.
  { tool: "createSubAgent", effect: "allow" },
  // Fetching a URL is read-only and respects robots.txt by default. Auto-allow
  // so the model can pull docs, references, and APIs without per-call prompts.
  // Outbound requests are still subject to sandbox network confinement when
  // configured (sandbox.network.*).
  { tool: "webfetch", effect: "allow" },
  // Searching the public web is read-only (returns title/url/snippet only) and,
  // like webfetch, stays subject to sandbox network confinement when configured.
  // Auto-allow so the model can discover URLs without a per-call prompt.
  { tool: "websearch", effect: "allow" },
];

// Read-only tools fenced to the workspace by `path` containment. All take a
// `path` (glob/grep optional, defaulting to cwd — checkPermission injects the
// canonical cwd when it is omitted so the `within` rule still matches).
const WORKSPACE_READ_TOOLS = ["read", "glob", "grep"] as const;

/**
 * Workspace-scoped allowance for the read-only tools (read/glob/grep): a call
 * is auto-allowed when its `path` resolves inside one of `roots` (the workspace
 * cwd plus any configured `additionalDirectories`). Containment is evaluated by
 * the engine's `within` matcher on the *canonical* path — the CLI's
 * `checkPermission` resolves and realpath()s the input first (see
 * path-safety.ts), so `..` traversal and symlink escape both reduce to "is the
 * real target inside a root?".
 *
 * write/edit deliberately get NO allow rule here: they fall through to the
 * engine's default `ask` everywhere (matching Claude Code's prompt-on-write
 * default). They are still canonicalized before evaluation, so a write whose
 * real target lands outside the workspace is correctly seen as out-of-tree by
 * any user-defined rule rather than slipping through on the raw string.
 */
export function workspaceReadRules(roots: readonly string[]): PermissionRule[] {
  const within = [...roots];
  return WORKSPACE_READ_TOOLS.map((tool) => ({
    tool,
    effect: "allow" as const,
    match: { path: { within } },
  }));
}

// File-touching tools auto-allowed inside the agent's auto-memory directory.
// read is included for the case where the store is configured outside the
// workspace (inside, workspaceReadRules already covers it); write/edit are the
// point of this rule — the agent owns this store and persisting a learned fact
// shouldn't prompt the user every time.
const AUTO_MEMORY_TOOLS = ["read", "write", "edit"] as const;

/**
 * Auto-allow read/write/edit whose canonical `path` lands inside the project's
 * auto-memory directory. This store (a MEMORY.md index plus one file per fact)
 * is maintained by the agent itself, so reading and writing inside it is part
 * of normal operation rather than something to confirm per call — mirroring how
 * `workspaceReadRules` fences the read-only tools, but extended to writes since
 * the agent legitimately owns this directory. `autoDir` must already be
 * canonicalized (see canonicalizeRoots) so containment compares real on-disk
 * locations. Scoped tightly to the memory dir, so writes elsewhere still ask.
 */
export function autoMemoryRules(autoDir: string): PermissionRule[] {
  const within = [autoDir];
  return AUTO_MEMORY_TOOLS.map((tool) => ({
    tool,
    effect: "allow" as const,
    match: { path: { within } },
  }));
}

/**
 * Merge user-provided rules with CLI defaults. User rules come first so the
 * PermissionEngine's first-match evaluation lets users override a default
 * (e.g. force `read` back to `ask`, or `write` inside the memory dir back to
 * `ask`). Auto-memory and workspace-scoped read rules sit between user rules and
 * other defaults so a global user override still wins. `roots` and
 * `autoMemoryDir` must already be canonicalized (see canonicalizeRoots).
 */
/**
 * Apply the bare-name tool denylist (`permissions.deny`): remove each listed
 * tool from the registry so it vanishes from every `definitions()` consumer —
 * the model's advertised tools, sub-agents, and `/context` — and can no longer
 * be dispatched (an unknown tool becomes an `is_error` tool_result). This is the
 * "remove from the tools array" form of deny (mirrors Claude Code's bare
 * `WebSearch`), distinct from a `rules` entry with `effect: "deny"`, which keeps
 * advertising the tool and rejects calls at dispatch time. Callers must apply it
 * AFTER every tool (builtins, MCP, createSubAgent) is registered. Returns which
 * names were actually removed vs. matched nothing (typos / already-absent) so
 * the caller can log the difference.
 */
export function applyToolDenylist(
  registry: { unregister(name: string): boolean },
  deny: readonly string[],
): { removed: string[]; missing: string[] } {
  const removed: string[] = [];
  const missing: string[] = [];
  for (const name of deny) {
    (registry.unregister(name) ? removed : missing).push(name);
  }
  return { removed, missing };
}

export function resolvePermissionRules(
  settings: Settings,
  roots: readonly string[],
  autoMemoryDir?: string,
): PermissionRule[] {
  return [
    ...settings.permissions.rules,
    ...(autoMemoryDir ? autoMemoryRules(autoMemoryDir) : []),
    ...workspaceReadRules(roots),
    ...DEFAULT_PERMISSION_RULES,
  ];
}
