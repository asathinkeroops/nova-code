import type { PermissionRule, Settings } from "@nova/runtime";

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
  { tool: "getTask", effect: "allow" },
  { tool: "getTaskList", effect: "allow" },
  { tool: "clearTaskList", effect: "allow" },
  { tool: "loadSkill", effect: "allow" },
  { tool: "checkLongRunningCommand", effect: "allow" },
  // The lsp tool is read-only (queries language servers; never mutates files).
  { tool: "lsp", effect: "allow" },
  // Spawning a sub-agent is itself safe to auto-allow: the sub-agent's own tool
  // calls run through this same PermissionEngine, so its bash/write/edit still
  // hit `ask`. Allowing the spawn just avoids a prompt for the delegation step.
  { tool: "createSubAgent", effect: "allow" },
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

/**
 * Merge user-provided rules with CLI defaults. User rules come first so the
 * PermissionEngine's first-match evaluation lets users override a default
 * (e.g. force `read` back to `ask`). Workspace-scoped read rules sit between
 * user rules and other defaults so a global `read → ask` user override still
 * wins. `roots` must already be canonicalized (see canonicalizeRoots).
 */
export function resolvePermissionRules(
  settings: Settings,
  roots: readonly string[],
): PermissionRule[] {
  return [...settings.permissions.rules, ...workspaceReadRules(roots), ...DEFAULT_PERMISSION_RULES];
}
