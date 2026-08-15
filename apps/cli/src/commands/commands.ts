import type { SlashCommandKind } from "@nova/runtime";
import { accent, ACCENT_HEX, cyan, dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import { pickerArrow } from "../ui/picker.js";
import { reloadFileCommands, reloadSkillCommands } from "../slash.js";

const TITLE = "/commands";

const KIND_TAG: Record<SlashCommandKind, string> = {
  builtin: "[builtin]",
  user: "[user]   ",
  project: "[project]",
  skill: "[skill]  ",
  mcp: "[mcp]    ",
  plugin: "[plugin] ",
};

export async function handleCommands(ctx: CliContext, arg: string): Promise<void> {
  if (arg === "reload") {
    const t0 = Date.now();
    const { added, errors } = await reloadFileCommands(ctx.registry, {
      cwd: ctx.workspace,
      settings: ctx.settings,
      logger: ctx.logger,
    });
    const skills = reloadSkillCommands(ctx.registry, {
      cwd: ctx.workspace,
      settings: ctx.settings,
      logger: ctx.logger,
      plugins: ctx.plugins,
      getSessionId: () => ctx.session.id,
      getEffort: () => ctx.thinkingLevel,
    });
    const ms = Date.now() - t0;
    const tail = errors > 0 ? t.cmdList.reloadErrors(errors) : "";
    ctx.screen.card(t.cmdList.reloaded(added, skills.added, ms, tail), { title: TITLE });
    return;
  }
  if (arg) {
    ctx.screen.card(t.cmdList.unknownSubcommand(arg), {
      kind: "error",
      title: TITLE,
    });
    return;
  }

  const cmds = ctx.registry.list();
  if (cmds.length === 0) {
    ctx.screen.card(dim(t.cmdList.noneRegistered), { title: TITLE });
    return;
  }
  const nameWidth = Math.min(20, Math.max(...cmds.map((c) => c.name.length + 1)));
  // Render as a picker rather than a plain pager so the current row is
  // highlighted and the (n/total) counter tracks it while the list scrolls —
  // the list is read-only, so enter and esc both simply close it.
  await ctx.screen.pickOne({
    items: cmds,
    header: `${accent(TITLE)}  ${dim(t.cmdList.count(cmds.length))}`,
    footer: dim(t.common.footerNavTopBottomClose),
    pageSize: 24,
    border: false,
    topRuleColor: ACCENT_HEX,
    render: (c, selected) => {
      const tag = KIND_TAG[c.source.kind];
      // Colour the command name (accent) and its parameters (cyan) distinctly
      // while the description keeps the default colour. Pad on the *visible*
      // length so the invisible ANSI codes don't throw off column alignment.
      const namePart = `/${c.name}`;
      const pad = " ".repeat(Math.max(0, nameWidth + 1 - namePart.length));
      const name = `${accent(namePart)}${pad}`;
      const hint = c.argHint ? ` ${cyan(c.argHint)}` : "";
      const shadowed = c.source.shadowedBy?.length
        ? dim(` (shadows ${c.source.shadowedBy.length})`)
        : "";
      return `${pickerArrow(selected)} ${dim(tag)} ${name}${hint}  ${c.description}${shadowed}`;
    },
  });
}
