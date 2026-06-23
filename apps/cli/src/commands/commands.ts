import type { SlashCommandKind } from "@nova/external";
import { accent, cyan, dim } from "../colors.js";
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
    return `${dim(tag)} ${name}${hint}  ${c.description}${shadowed}`;
  });
  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
