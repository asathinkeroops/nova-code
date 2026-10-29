import type { CliContext } from "./ctx-types.js";
import { reloadSkillCommands } from "./slash.js";

/**
 * Refresh everything derived from the on-disk skill set, in one place.
 *
 * The index, `/skills`, `loadSkill` and the `/{name}` slash commands all read
 * the same memoized scan, so refreshing only the index leaves the command
 * registry describing the previous skill set — a renamed skill becomes
 * unreachable while its old command survives. Session boundaries and
 * `/commands reload` both go through here so the four views cannot drift again.
 *
 * Skills stay bound to the launch workspace (`skillsIndex.workspace`), not
 * `ctx.workspace`: a worktree switch must not change which skills exist.
 */
export function refreshSkillsAndCommands(ctx: CliContext): { added: number } {
  ctx.skillsIndex.refresh();
  return reloadSkillCommands(ctx.registry, {
    cwd: ctx.skillsIndex.workspace,
    settings: ctx.settings,
    logger: ctx.logger,
    plugins: ctx.plugins,
    getSessionId: () => ctx.session.id,
    getEffort: () => ctx.thinkingLevel,
  });
}
