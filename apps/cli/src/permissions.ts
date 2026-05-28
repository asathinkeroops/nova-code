import type { PermissionRule, Settings } from "@nova/runtime";

/**
 * Built-in tools the CLI always seeds as `allow`. These names mirror the
 * handlers registered by `builtinTools()` in @nova/tools; if you add a new
 * read-only/safe builtin tool, add it here too.
 *
 * `read` is NOT here — it gets workspace-scoped rules from
 * `workspaceReadRules(cwd)` so reads inside the project allow, but reads
 * pointing outside (absolute paths off-cwd, or relative paths that traverse
 * via `..`) fall through to `ask`.
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
  { tool: "grep", effect: "allow" },
  { tool: "glob", effect: "allow" },
  { tool: "loadSkill", effect: "allow" },
  { tool: "checkLongRunningCommand", effect: "allow" },
  // Spawning a sub-agent is itself safe to auto-allow: the sub-agent's own tool
  // calls run through this same PermissionEngine, so its bash/write/edit still
  // hit `ask`. Allowing the spawn just avoids a prompt for the delegation step.
  { tool: "createSubAgent", effect: "allow" },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Workspace-scoped allowance for `read`: a path is auto-allowed if it is
 * either (a) a cwd-relative path with no `..` segment, or (b) an absolute
 * path under cwd. Anything else falls through to the engine's `ask`.
 */
export function workspaceReadRules(cwd: string): PermissionRule[] {
  const escaped = escapeRegex(cwd);
  return [
    // Relative path: not starting with `/`, no `..` path segment anywhere.
    {
      tool: "read",
      effect: "allow",
      match: { path: "/^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$/" },
    },
    // Absolute path under cwd (boundary is `/` or end of string to avoid
    // matching sibling dirs like `/cwd-other/...`).
    {
      tool: "read",
      effect: "allow",
      match: { path: `/^${escaped}(/|$)/` },
    },
  ];
}

/**
 * Merge user-provided rules with CLI defaults. User rules come first so the
 * PermissionEngine's first-match evaluation lets users override a default
 * (e.g. force `read` back to `ask`). Workspace-scoped read rules sit between
 * user rules and other defaults so a global `read → ask` user override still
 * wins.
 */
export function resolvePermissionRules(settings: Settings, cwd: string): PermissionRule[] {
  return [
    ...settings.permissions.rules,
    ...workspaceReadRules(cwd),
    ...DEFAULT_PERMISSION_RULES,
  ];
}
