import type { SlashCommand, SlashCommandKind } from "@nova/external";
import { dim } from "../colors.js";
import type { CliContext } from "../context.js";

const SECTION_TITLE: Record<SlashCommandKind, string> = {
  builtin: "Built-in",
  project: "Project",
  user: "User",
};
const SECTION_ORDER: SlashCommandKind[] = ["builtin", "project", "user"];

function formatRow(cmd: SlashCommand, nameWidth: number): string {
  const name = `/${cmd.name}${cmd.argHint ? ` ${cmd.argHint}` : ""}`.padEnd(nameWidth + 2, " ");
  return `  ${name}${cmd.description}`;
}

export function handleHelp(ctx: CliContext): void {
  const all = ctx.registry.list();
  const grouped = new Map<SlashCommandKind, SlashCommand[]>();
  for (const c of all) {
    const arr = grouped.get(c.source.kind) ?? [];
    arr.push(c);
    grouped.set(c.source.kind, arr);
  }
  const sections: string[] = [];
  for (const kind of SECTION_ORDER) {
    const group = grouped.get(kind);
    if (!group || group.length === 0) continue;
    const nameWidth = Math.min(
      24,
      Math.max(...group.map((c) => `/${c.name}${c.argHint ? ` ${c.argHint}` : ""}`.length)),
    );
    sections.push(dim(`${SECTION_TITLE[kind]}:`));
    for (const c of group) sections.push(formatRow(c, nameWidth));
  }
  sections.push("");
  sections.push(dim("Ctrl+D or /exit to leave. /commands lists everything; /commands reload re-scans files."));
  ctx.screen.card(sections.join("\n"), { title: "/help" });
}
