import {
  SlashRegistry,
  fileCommandToSlash,
  loadFileCommands,
  type SlashCommand,
} from "@nova/external";
import { getSkill, getSkillList, renderSkillPayload } from "@nova/tools";
import type { Logger, Settings } from "@nova/runtime";
import { pluginSkillRoots } from "./plugins/loader.js";
import type { LoadedPlugin } from "./plugins/loader.js";
import type { SlashCommand as UISlashCommand } from "./ui/input-box.js";

interface LoadOpts {
  cwd: string;
  settings: Settings;
  logger: Logger;
  /**
   * Loaded plugins. Their skill directories must be folded into the same scan
   * the model-facing index uses, or the two views disagree about which skills
   * exist — see `pluginSkillRoots`.
   */
  plugins?: readonly LoadedPlugin[];
  /**
   * Live reads of session id / effort for `${*_SESSION_ID}` / `${*_EFFORT}`.
   * Getters, not values: `/resume` and `/effort` change them mid-session, and
   * the registry is built once.
   */
  getSessionId?: () => string;
  getEffort?: () => string;
}

/**
 * Scan disk for .md slash commands and register them. Builtins (added by
 * callers via `registry.register`) always beat file commands on name
 * collisions; the shadowing is recorded on the winner's source.shadowedBy.
 */
export async function loadFileCommandsInto(
  registry: SlashRegistry,
  opts: LoadOpts,
): Promise<{ added: number; errors: number }> {
  if (!opts.settings.slash.enabled) return { added: 0, errors: 0 };
  const result = await loadFileCommands({
    cwd: opts.cwd,
    ...(opts.settings.slash.projectDirs ? { projectDirs: opts.settings.slash.projectDirs } : {}),
    ...(opts.settings.slash.userPaths ? { userPaths: opts.settings.slash.userPaths } : {}),
    ...(opts.settings.slash.extraDirs ? { extraDirs: opts.settings.slash.extraDirs } : {}),
  });
  for (const raw of result.commands) {
    registry.register(fileCommandToSlash(raw));
  }
  for (const err of result.errors) {
    opts.logger.warn({ path: err.path, err: err.message }, "slash command parse failed");
  }
  return { added: result.commands.length, errors: result.errors.length };
}

/**
 * Replace all file-backed commands in `registry` with a fresh scan. Used by
 * `/commands reload`. Builtins are left untouched.
 */
export async function reloadFileCommands(
  registry: SlashRegistry,
  opts: LoadOpts,
): Promise<{ added: number; errors: number }> {
  registry.clearKind("user");
  registry.clearKind("project");
  return loadFileCommandsInto(registry, opts);
}

/**
 * Register every discovered skill as a slash command so `/{skill-name}` is a
 * direct shortcut for invoking it.
 *
 * A user-typed `/{name} args` expands the SKILL.md **inline** and injects it as
 * the next prompt — one hop, so `$ARGUMENTS` / `$1`..`$N` in the body can bind
 * to what the user typed. (The model's own route is the `loadSkill` tool, which
 * takes a name and nothing else; there is no way for typed arguments to survive
 * that trip, which is why the two paths differ here.) Both render through
 * `renderSkillPayload`, so the model sees identical text either way.
 *
 * Must be called AFTER builtins and file commands are registered: skill
 * commands are never builtin, so on a name collision the already-registered
 * command wins and the skill is recorded in its `shadowedBy`. This keeps an
 * explicit `/foo` (builtin or user/project `.md`) authoritative over a skill
 * that happens to be named `foo`.
 */
export function loadSkillCommandsInto(
  registry: SlashRegistry,
  opts: LoadOpts,
): { added: number } {
  if (!opts.settings.skills.enabled) return { added: 0 };
  // One options object for both the listing scan and the per-invocation reread.
  // Every field that takes part in the scan cache key (extraDirs, pluginRoots,
  // maxFileBytes) must match what context.ts passes, or the slash registry and
  // the model-facing index get built from two different scans.
  const pluginSkills = pluginSkillRoots(opts.plugins ?? []);
  const extraDirs = [...(opts.settings.skills.extraDirs ?? []), ...pluginSkills.dirs];
  const skillsOpts = {
    cwd: opts.cwd,
    ...(opts.settings.skills.projectDirs ? { projectDirs: opts.settings.skills.projectDirs } : {}),
    ...(opts.settings.skills.userPaths ? { userPaths: opts.settings.skills.userPaths } : {}),
    ...(extraDirs.length > 0 ? { extraDirs } : {}),
    ...(pluginSkills.dirs.length > 0 ? { pluginRoots: pluginSkills.roots } : {}),
    maxFileBytes: opts.settings.skills.maxFileBytes,
    logger: opts.logger,
  };
  const items = getSkillList(skillsOpts);
  // register() returns {} both for a fresh add and for a shadowed no-op, so we
  // pre-snapshot the taken names to count only the commands we actually added.
  const taken = new Set(registry.list().map((c) => c.name));
  let added = 0;
  for (const item of items) {
    // `user-invocable: false` skills are model-only: skip registering the
    // `/{name}` shortcut so they never appear in the slash menu.
    if (!item.userInvocable) continue;
    const cmd: SlashCommand = {
      name: item.name,
      description: item.description,
      argHint: "[args]",
      source: { kind: "skill", path: item.location },
      run: async (ctx, args) => {
        // Reread rather than trusting the scan's body: the file may have been
        // edited (or grown past maxFileBytes) since startup, and `/{name}`
        // should always run what is on disk right now.
        const loaded = getSkill({ name: item.name }, skillsOpts);
        if (!loaded) {
          return {
            kind: "error",
            message: `skill "${item.name}" is no longer readable at ${item.location}. Run /commands reload after fixing it.`,
          };
        }
        return {
          kind: "prompt",
          text: await renderSkillPayload(item.name, loaded.body, {
            location: loaded.location,
            cwd: ctx.cwd,
            args,
            ...(loaded.pluginRoot !== undefined ? { pluginRoot: loaded.pluginRoot } : {}),
            ...(opts.getSessionId ? { sessionId: opts.getSessionId() } : {}),
            ...(opts.getEffort ? { effort: opts.getEffort() } : {}),
            ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
            maxResponseBytes: opts.settings.skills.maxResponseBytes,
            ...(opts.settings.skills.disableShellExecution
              ? { disableShellExecution: true }
              : {}),
          }),
        };
      },
    };
    registry.register(cmd);
    if (!taken.has(item.name)) added++;
  }
  return { added };
}

/**
 * Replace all skill-backed commands in `registry` with a fresh scan. Used by
 * `/commands reload`. Builtins and file commands are left untouched.
 */
export function reloadSkillCommands(
  registry: SlashRegistry,
  opts: LoadOpts,
): { added: number } {
  registry.clearKind("skill");
  return loadSkillCommandsInto(registry, opts);
}

/**
 * Map a registry entry into the shape expected by the input-box popup.
 * `argHint` (when present) is appended to the description so it shows next
 * to the name as the user types.
 */
export function toUiSlashCommands(cmds: SlashCommand[]): UISlashCommand[] {
  return cmds.map((c) => ({
    name: `/${c.name}`,
    description: c.argHint ? `${c.argHint}  ${c.description}` : c.description,
  }));
}
