import type { SlashCommand, SlashCommandKind } from "@nova/base";
import { accent, ACCENT_HEX, cyan, dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import { pickerArrow } from "../ui/picker.js";

// Read at call time (see i18n invariant), keyed by command kind.
function sectionTitle(kind: SlashCommandKind): string {
  switch (kind) {
    case "builtin":
      return t.help.sectionBuiltin;
    case "project":
      return t.help.sectionProject;
    case "user":
      return t.help.sectionUser;
    case "skill":
      return t.help.sectionSkill;
    case "mcp":
      return t.help.sectionMcp;
    case "plugin":
      return t.help.sectionPlugin;
  }
}
const SECTION_ORDER: SlashCommandKind[] = ["builtin", "project", "user", "skill", "mcp", "plugin"];

/** One line of the /help list: either a selectable command or a static row. */
type HelpRow = { selectable: boolean; text: string };

function formatRow(cmd: SlashCommand, nameWidth: number): string {
  // Colour the command name (accent) and its parameters (cyan) distinctly while
  // the description keeps the default colour. Pad on the *visible* length so the
  // invisible ANSI codes don't throw off column alignment. The selection arrow
  // (added at render time) supplies the leading indent for command rows.
  const namePart = `/${cmd.name}`;
  const argPart = cmd.argHint ? ` ${cmd.argHint}` : "";
  const pad = " ".repeat(Math.max(0, nameWidth + 2 - namePart.length - argPart.length));
  const coloured = `${accent(namePart)}${argPart ? cyan(argPart) : ""}`;
  return `${coloured}${pad}${cmd.description}`;
}

export async function handleHelp(ctx: CliContext): Promise<void> {
  const all = ctx.registry.list();
  const grouped = new Map<SlashCommandKind, SlashCommand[]>();
  for (const c of all) {
    const arr = grouped.get(c.source.kind) ?? [];
    arr.push(c);
    grouped.set(c.source.kind, arr);
  }
  const rows: HelpRow[] = [];
  for (const kind of SECTION_ORDER) {
    const group = grouped.get(kind);
    if (!group || group.length === 0) continue;
    const nameWidth = Math.min(
      24,
      Math.max(...group.map((c) => `/${c.name}${c.argHint ? ` ${c.argHint}` : ""}`.length)),
    );
    rows.push({ selectable: false, text: dim(`${sectionTitle(kind)}:`) });
    for (const c of group) rows.push({ selectable: true, text: formatRow(c, nameWidth) });
  }
  rows.push({ selectable: false, text: "" });
  rows.push({ selectable: false, text: dim(t.help.pasteHint) });
  rows.push({ selectable: false, text: dim(t.help.leaveHint) });

  // A picker rather than a plain pager so the current command is highlighted as
  // the list scrolls; section headers and notes are non-selectable, so ↑↓ skips
  // straight between commands. Read-only — enter and esc both just close it.
  await ctx.screen.pickOne({
    items: rows,
    header: `${accent("/help")}  ${dim(t.help.commandCount(all.length))}`,
    footer: dim(t.help.navFooter),
    pageSize: 24,
    border: false,
    topRuleColor: ACCENT_HEX,
    selectable: (r) => r.selectable,
    render: (r, selected) => (r.selectable ? `${pickerArrow(selected)} ${r.text}` : r.text),
  });
}
