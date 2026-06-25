import type { SlashCommand, SlashCommandKind } from "@nova/external";
import { accent, cyan, dim } from "../colors.js";
import type { CliContext } from "../context.js";

const SECTION_TITLE: Record<SlashCommandKind, string> = {
  builtin: "Built-in",
  project: "Project",
  user: "User",
  mcp: "MCP",
};
const SECTION_ORDER: SlashCommandKind[] = ["builtin", "project", "user", "mcp"];

function formatRow(cmd: SlashCommand, nameWidth: number): string {
  // Colour the command name (accent) and its parameters (cyan) distinctly while
  // the description keeps the default colour. Pad on the *visible* length so the
  // invisible ANSI codes don't throw off column alignment.
  const namePart = `/${cmd.name}`;
  const argPart = cmd.argHint ? ` ${cmd.argHint}` : "";
  const pad = " ".repeat(Math.max(0, nameWidth + 2 - namePart.length - argPart.length));
  const coloured = `${accent(namePart)}${argPart ? cyan(argPart) : ""}`;
  return `  ${coloured}${pad}${cmd.description}`;
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
  sections.push(dim("Paste an image (Cmd/Ctrl+V) or drag a file in — it's inserted as a path the model reads."));
  sections.push(dim("Ctrl+D or /exit to leave. /commands lists everything; /commands reload re-scans files."));
  ctx.screen.card(sections.join("\n"), { title: "/help" });
}
