import {
  SlashRegistry,
  fileCommandToSlash,
  loadFileCommands,
  type SlashCommand,
} from "@nova/external";
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
