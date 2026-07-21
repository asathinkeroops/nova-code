import {
  SlashRegistry,
  fileCommandToSlash,
  loadFileCommands,
  type SlashCommand,
} from "@nova/external";
import { getSkillList } from "@nova/tools";
import type { Logger, Settings } from "@nova/runtime";
import type { SlashCommand as UISlashCommand } from "./ui/input-box.js";

interface LoadOpts {
  cwd: string;
  settings: Settings;
  logger: Logger;
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
 * Build the prompt a skill slash command injects when invoked. The agent is
 * told to load the skill through the existing `loadSkill` tool (which reads the
 * SKILL.md body fresh from disk) and follow it, with any typed args forwarded.
 */
function skillPrompt(name: string, rawArgs: string): string {
  const args = rawArgs.trim();
  const base =
    `Run the "${name}" skill: call the \`loadSkill\` tool with name "${name}", ` +
    `then follow the returned instructions.`;
  return args.length > 0 ? `${base}\n\nArguments: ${args}` : base;
}

/**
 * Register every discovered skill as a slash command so `/{skill-name}` is a
 * direct shortcut for invoking it. Each command emits a `prompt` outcome (see
 * `skillPrompt`) rather than running inline.
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
  const items = getSkillList({
    cwd: opts.cwd,
    ...(opts.settings.skills.projectDirs ? { projectDirs: opts.settings.skills.projectDirs } : {}),
    ...(opts.settings.skills.userPaths ? { userPaths: opts.settings.skills.userPaths } : {}),
    ...(opts.settings.skills.extraDirs ? { extraDirs: opts.settings.skills.extraDirs } : {}),
    logger: opts.logger,
  });
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
      run: (_ctx, args) => ({ kind: "prompt", text: skillPrompt(item.name, args) }),
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
