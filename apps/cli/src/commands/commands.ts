import type { SlashCommandKind } from "@nova/external";
import { dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { reloadFileCommands } from "../slash.js";

const TITLE = "/commands";

const KIND_TAG: Record<SlashCommandKind, string> = {
  builtin: "[builtin]",
  user: "[user]   ",
  project: "[project]",
};

export async function handleCommands(ctx: CliContext, arg: string): Promise<void> {
  if (arg === "reload") {
    const t0 = Date.now();
    const { added, errors } = await reloadFileCommands(ctx.registry, {
      cwd: ctx.workspace,
      settings: ctx.settings,
      logger: ctx.logger,
    });
    const ms = Date.now() - t0;
    const tail = errors > 0 ? ` · ${errors} error(s) — see log` : "";
    ctx.screen.card(`reloaded ${added} file command(s) in ${ms}ms${tail}`, { title: TITLE });
    return;
  }
  if (arg) {
    ctx.screen.card(`unknown subcommand "${arg}". try /commands or /commands reload.`, {
      kind: "error",
      title: TITLE,
    });
    return;
  }

  const cmds = ctx.registry.list();
  if (cmds.length === 0) {
    ctx.screen.card(dim("no commands registered."), { title: TITLE });
    return;
  }
  const nameWidth = Math.min(20, Math.max(...cmds.map((c) => c.name.length + 1)));
  const lines = cmds.map((c) => {
    const tag = KIND_TAG[c.source.kind];
    const name = `/${c.name}`.padEnd(nameWidth + 1, " ");
    const hint = c.argHint ? ` ${dim(c.argHint)}` : "";
    const shadowed = c.source.shadowedBy?.length
      ? dim(` (shadows ${c.source.shadowedBy.length})`)
      : "";
    return `${dim(tag)} ${name}${hint}  ${c.description}${shadowed}`;
  });
  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
