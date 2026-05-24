import { HELP_TEXT } from "../constants.js";
import type { CliContext } from "../context.js";

export function handleHelp(ctx: CliContext): void {
  ctx.screen.card(HELP_TEXT, { title: "/help" });
}
