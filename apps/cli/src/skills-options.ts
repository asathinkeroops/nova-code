import type { Logger, Settings } from "@nova/base";
import type { SkillsOptions } from "@nova/tools";
import { pluginSkillRoots, type LoadedPlugin } from "./plugins/loader.js";

export interface CreateSkillsOptionsInput {
  settings: Settings;
  /** Startup workspace. Skills stay bound to it across a worktree switch. */
  workspace: string;
  plugins?: readonly LoadedPlugin[];
  logger?: Logger;
}

/**
 * The one place a `SkillsOptions` object is built.
 *
 * Every consumer — the startup scan, the `loadSkill` tool, the slash-command
 * bridge, `/skills` and the injected index — must pass a byte-identical options
 * set, because `getSkillList` memoizes on `JSON.stringify(resolvedOpts)`. Two
 * spellings of the same configuration are two independent scans that can drift
 * the moment plugin roots or `maxFileBytes` change.
 */
export function createSkillsOptions(input: CreateSkillsOptionsInput): SkillsOptions | undefined {
  const { settings, workspace, plugins = [], logger } = input;
  if (!settings.skills.enabled) return undefined;

  // Plugin-contributed roots are folded in here rather than at each call site;
  // `pluginRoots` keeps the owning plugin associated so `${PLUGIN_ROOT}` in a
  // skill body still resolves.
  const pluginSkills = pluginSkillRoots(plugins);
  const extraDirs = [...(settings.skills.extraDirs ?? []), ...pluginSkills.dirs];

  return {
    cwd: workspace,
    ...(settings.skills.projectDirs ? { projectDirs: settings.skills.projectDirs } : {}),
    ...(settings.skills.userPaths ? { userPaths: settings.skills.userPaths } : {}),
    ...(extraDirs.length > 0 ? { extraDirs } : {}),
    ...(pluginSkills.dirs.length > 0 ? { pluginRoots: pluginSkills.roots } : {}),
    maxResponseBytes: settings.skills.maxResponseBytes,
    maxFileBytes: settings.skills.maxFileBytes,
    disableShellExecution: settings.skills.disableShellExecution,
    ...(logger ? { logger } : {}),
  };
}
