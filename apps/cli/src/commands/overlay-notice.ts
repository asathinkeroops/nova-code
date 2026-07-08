import { accent, dim, PURPLE_HEX } from "../colors.js";
import type { CliContext } from "../context.js";

/**
 * Show a command's "nothing interactive to display" state — empty, disabled, or
 * an idle notice — in the same purple top-rule 弹层 the command's pickers use, so
 * an empty result reads consistently with a populated one instead of dropping a
 * plain inline card. Falls back to a card when there's no interactive TTY to host
 * and dismiss a modal (headless / piped output), where a viewer would hang.
 */
export function overlayNotice(ctx: CliContext, title: string, lines: string[]): Promise<void> {
  if (!ctx.screen.interactive || !process.stdout.isTTY) {
    ctx.screen.card(lines.join("\n"), { title });
    return Promise.resolve();
  }
  return ctx.screen.viewer({
    lines,
    header: accent(title),
    footer: dim("enter/esc/q close"),
    border: false,
    topRuleColor: PURPLE_HEX,
  });
}
