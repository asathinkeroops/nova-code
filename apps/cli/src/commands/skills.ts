import { getSkillList } from "@nova/tools";
import { dim } from "../colors.js";
import type { CliContext } from "../context.js";

const TITLE = "/skills";

export function handleSkills(ctx: CliContext): void {
  if (!ctx.settings.skills.enabled) {
    ctx.screen.card(dim("skills disabled in settings."), { title: TITLE });
    return;
  }
  const items = getSkillList({
    cwd: ctx.workspace,
    ...(ctx.settings.skills.projectDirs ? { projectDirs: ctx.settings.skills.projectDirs } : {}),
    ...(ctx.settings.skills.userPaths ? { userPaths: ctx.settings.skills.userPaths } : {}),
    ...(ctx.settings.skills.extraDirs ? { extraDirs: ctx.settings.skills.extraDirs } : {}),
    logger: ctx.logger,
  });
  if (items.length === 0) {
    ctx.screen.card(dim("no skills found."), { title: TITLE });
    return;
  }
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.min(24, Math.max(...sorted.map((s) => s.name.length)));
  const lines = sorted.map((s) => {
    const name = s.name.padEnd(nameWidth, " ");
    const trig =
      s.triggers.length > 0 ? `  ${dim(`triggers: ${s.triggers.join(", ")}`)}` : "";
    return `  ${name}  ${s.description}${trig}`;
  });
  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
